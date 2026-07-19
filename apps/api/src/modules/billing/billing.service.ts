import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Plan, Subscription } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../common/prisma.service';
import { PaymentAggregatorService } from './payment-aggregator.service';
import { ConfigService } from '@nestjs/config';

export type SubscriptionWithPlan = Subscription & { plan: Plan };

export interface BillingJobData {
  organizationId: string;
  invoiceId?: string;
  planId?: string;
  period?: 'monthly' | 'annual';
}

const MS_24H = 24 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;
const MS_30D = 30 * 24 * 60 * 60 * 1000;
const MS_365D = 365 * 24 * 60 * 60 * 1000;

/**
 * Service de facturation : subscription, factures, liens de paiement et surveillance du CA d'essai.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregator: PaymentAggregatorService,
    private readonly config: ConfigService,
    @InjectQueue('billing') private readonly billingQueue: Queue<BillingJobData>,
  ) {}

  // ─── Lecture ──────────────────────────────────────────────────────────────

  /**
   * Retourne la subscription active avec son plan pour une organisation.
   * Lève NotFoundException si aucune subscription n'existe (état incohérent).
   */
  async getSubscription(organizationId: string): Promise<SubscriptionWithPlan> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) {
      this.logger.error(`Aucune subscription pour l'organisation ${organizationId}`);
      throw new NotFoundException('Abonnement introuvable pour cette organisation.');
    }

    return subscription;
  }

  /**
   * Retourne la valeur désérialisée d'un PlatformSetting, ou null si la clé est absente.
   * La valeur est stockée comme JSON string (ex. `"2026-09-30T23:59:59Z"`).
   */
  async getPlatformSetting(key: string): Promise<string | null> {
    const setting = await this.prisma.platformSetting.findUnique({
      where: { key },
      select: { value: true },
    });

    if (!setting) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(setting.value);
    } catch {
      this.logger.error(`PlatformSetting "${key}" contient une valeur JSON invalide : ${setting.value}`);
      throw new InternalServerErrorException('Erreur de configuration interne.');
    }

    if (typeof parsed !== 'string') {
      this.logger.error(`PlatformSetting "${key}" n'est pas une chaîne : ${JSON.stringify(parsed)}`);
      throw new InternalServerErrorException('Erreur de configuration interne.');
    }

    return parsed;
  }

  // ─── Facturation ──────────────────────────────────────────────────────────

  /**
   * Crée une Invoice PENDING, génère un lien de paiement via l'agrégateur
   * et planifie un job d'expiration dans 24h.
   *
   * @returns invoiceId et paymentUrl à transmettre au client
   */
  async createPaymentLink(
    organizationId: string,
    planId: string,
    period: 'monthly' | 'annual',
  ): Promise<{ invoiceId: string; paymentUrl: string }> {
    const subscription = await this.getSubscription(organizationId);

    // Le planId fourni doit correspondre au plan actif — les changements de plan passent
    // par un endpoint dédié (non encore implémenté, prévu post-T07).
    if (planId !== subscription.planId) {
      throw new UnprocessableEntityException(
        'Ce plan ne correspond pas à votre abonnement actuel. Contactez le support pour changer de plan.',
      );
    }

    const amount = period === 'annual'
      ? subscription.plan.priceAnnual
      : subscription.plan.priceMonthly;

    const dueAt = new Date(Date.now() + MS_24H);
    const callbackUrl = this.config.get<string>('PAYMENT_AGGREGATOR_CALLBACK_URL')
      ?? `http://localhost:3000/api/v1/webhooks/billing`;

    const invoice = await this.prisma.invoice.create({
      data: {
        organizationId,
        subscriptionId: subscription.id,
        amount,
        currency: 'XAF',
        status: 'PENDING',
        dueAt,
        period,
      },
    });

    const paymentUrl = await this.aggregator.generatePaymentLink({
      amount,
      currency: 'XAF',
      reference: invoice.id,
      callbackUrl,
    });

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { paymentLink: paymentUrl },
    });

    await this.billingQueue.add(
      'invoice.expire',
      { invoiceId: invoice.id, organizationId, planId: subscription.planId, period },
      { delay: MS_24H },
    );

    return { invoiceId: invoice.id, paymentUrl };
  }

  /**
   * Confirme le paiement d'une facture et active la subscription.
   * Idempotent : une Invoice déjà PAID n'est pas retraitée.
   *
   * @param invoiceId - identifiant de la facture confirmée par le webhook
   */
  async confirmPayment(invoiceId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { subscription: true },
    });

    if (!invoice) {
      this.logger.error(`confirmPayment : Invoice ${invoiceId} introuvable`);
      throw new NotFoundException(`Facture ${invoiceId} introuvable.`);
    }

    // Idempotence applicative : déjà confirmée, on ne prolonge pas une deuxième fois
    if (invoice.status === 'PAID') {
      this.logger.warn(`confirmPayment : Invoice ${invoiceId} déjà PAID — ignorée`);
      return;
    }

    const periodMs = invoice.period === 'annual' ? MS_365D : MS_30D;
    // Si le paiement arrive avant la fin de la période courante (renouvellement anticipé),
    // la nouvelle période commence à la fin de la période courante. Sinon, elle commence maintenant.
    const base = Math.max(Date.now(), invoice.subscription.currentPeriodEnd.getTime());
    const newPeriodEnd = new Date(base + periodMs);

    await this.prisma.$transaction([
      this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'PAID', paidAt: new Date() },
      }),
      this.prisma.subscription.update({
        where: { id: invoice.subscriptionId },
        data: { status: 'ACTIVE', currentPeriodEnd: newPeriodEnd },
      }),
    ]);

    // Job de renouvellement 7 jours avant la prochaine échéance
    const renewDelay = Math.max(0, periodMs - MS_7D);
    await this.billingQueue.add(
      'invoice.renew',
      {
        organizationId: invoice.organizationId,
        planId: invoice.subscription.planId,
        period: invoice.period as 'monthly' | 'annual',
      },
      { delay: renewDelay },
    );
  }

  /**
   * Vérifie si le CA cumulé de l'organisation dépasse le plafond d'essai du plan.
   * Si oui, passe la Subscription en PAST_DUE (§17 point R).
   * Appelé par le job billing.checkTrialCap.
   *
   * @param organizationId - tenant à vérifier
   * @returns true si le plafond a été atteint et la subscription dégradée, false sinon
   */
  async checkTrialCap(organizationId: string): Promise<boolean> {
    const subscription = await this.getSubscription(organizationId);

    // Hors essai ou déjà dégradé — rien à faire
    if (subscription.status !== 'TRIALING') return false;

    const capAmount = subscription.plan.trialRevenueCapAmount;
    // Plan sans plafond (fenêtre de lancement ou enterprise) — rien à faire
    if (!capAmount) return false;

    // CA cumulé = somme des ventes validées depuis l'inscription
    // Note : Sale n'existe pas encore (Bloc C) — on aggrège sur les invoices PAID de l'org
    // comme proxy du CA SaaS ; le vrai CA métier (ventes) sera câblé en S31.
    const result = await this.prisma.invoice.aggregate({
      where: { organizationId, status: 'PAID' },
      _sum: { amount: true },
    });

    const cumulativeRevenue: Decimal = result._sum.amount ?? new Decimal(0);

    if (cumulativeRevenue.greaterThanOrEqualTo(capAmount)) {
      this.logger.warn(
        `checkTrialCap : CA cumulé ${cumulativeRevenue} >= plafond ${capAmount} pour ${organizationId} — passage PAST_DUE`,
      );

      await this.prisma.subscription.update({
        where: { organizationId },
        data: { status: 'PAST_DUE' },
      });

      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { trialEndedReason: 'REVENUE_CAP' },
      });

      return true;
    }

    return false;
  }

  /**
   * Expire une facture PENDING (délai dépassé sans confirmation).
   * Passe Invoice → FAILED, Subscription → PAST_DUE.
   */
  async expireInvoice(invoiceId: string, organizationId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });

    if (!invoice || invoice.status !== 'PENDING') return;

    await this.prisma.$transaction([
      this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED' },
      }),
      this.prisma.subscription.update({
        where: { organizationId },
        data: { status: 'PAST_DUE' },
      }),
    ]);
  }
}
