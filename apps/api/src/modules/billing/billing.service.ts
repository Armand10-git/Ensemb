import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import type { Plan, Subscription } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

export type SubscriptionWithPlan = Subscription & { plan: Plan };

/**
 * Service d'accès aux données de facturation : subscription active et paramètres plateforme.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

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

    try {
      return JSON.parse(setting.value) as string;
    } catch {
      this.logger.error(`PlatformSetting "${key}" contient une valeur JSON invalide : ${setting.value}`);
      throw new InternalServerErrorException('Erreur de configuration interne.');
    }
  }
}
