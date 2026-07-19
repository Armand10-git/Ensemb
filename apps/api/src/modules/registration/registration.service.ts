import { ConflictException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { RegisterOrganizationDto } from './dto/register-organization.dto';
import { RESERVED_SUBDOMAINS } from './dto/register-organization.dto';

/** Coût bcrypt pour le hash du mot de passe administrateur (identique à AuthService). */
const BCRYPT_ROUNDS = 12;

export interface RegistrationResult {
  organizationId: string;
  subdomain: string;
  adminUserId: string;
}

/**
 * Calcule la date de fin d'essai selon la politique fenêtre de lancement (§17 point R).
 *
 * - Pendant la fenêtre : trialEndsAt = launchPromoEndsAt (pas de plafond CA)
 * - Après la fenêtre ou si launchPromoEndsAt est null : trialEndsAt = now + trialDurationDays
 *
 * Fonction pure exportée pour être testée indépendamment du service.
 */
export function computeTrialPeriod(
  now: Date,
  launchPromoEndsAt: Date | null,
  trialDurationDays: number,
): Date {
  if (launchPromoEndsAt !== null && now < launchPromoEndsAt) {
    return new Date(launchPromoEndsAt.getTime());
  }
  return new Date(now.getTime() + trialDurationDays * 24 * 60 * 60 * 1000);
}

/**
 * Gère l'inscription d'une nouvelle organisation (tenant).
 * Toutes les créations se font dans une transaction atomique :
 * Organization + User admin + Role "Administrateur" + assignation + Subscription TRIALING.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vérifie la disponibilité d'un sous-domaine.
   * La réponse est intentionnellement neutre { available: boolean } —
   * elle ne révèle pas si une organisation existe déjà (anti-énumération).
   */
  async checkSubdomainAvailability(subdomain: string): Promise<{ available: boolean }> {
    if ((RESERVED_SUBDOMAINS as readonly string[]).includes(subdomain)) {
      return { available: false };
    }

    const existing = await this.prisma.organization.findUnique({
      where: { subdomain },
      select: { id: true },
    });

    return { available: existing === null };
  }

  /**
   * Crée une nouvelle organisation avec son premier administrateur.
   *
   * Transaction atomique (§18.0 étape 3) :
   * 1. Lecture de PlatformSetting.launchPromoEndsAt et du plan starter
   * 2. Organization (status TRIALING, trialEndsAt calculé selon §17 point R)
   * 3. Role "Administrateur" avec toutes les permissions du catalogue global
   * 4. User admin (bcrypt cost 12)
   * 5. Assignation du rôle à l'utilisateur
   * 6. Subscription TRIALING liée au plan starter
   *
   * Si n'importe quelle étape échoue, tout est rollbacké — aucune création partielle.
   * Le catch P2002 protège contre la race condition sous-domaine.
   */
  async register(dto: RegisterOrganizationDto): Promise<RegistrationResult> {
    const { available } = await this.checkSubdomainAvailability(dto.subdomain);
    if (!available) {
      throw new ConflictException('Ce sous-domaine n\'est pas disponible.');
    }

    const hashedPassword = await bcrypt.hash(dto.adminPassword, BCRYPT_ROUNDS);
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lecture de la fenêtre de lancement et du plan starter dans la transaction
        const [launchPromoSetting, starterPlan, allPermissions] = await Promise.all([
          tx.platformSetting.findUnique({ where: { key: 'launchPromoEndsAt' }, select: { value: true } }),
          tx.plan.findUnique({ where: { name: 'starter' }, select: { id: true, trialDurationDays: true } }),
          tx.permission.findMany({ select: { id: true } }),
        ]);

        if (!starterPlan) {
          this.logger.error('Plan starter introuvable en base — le seed doit être relancé.');
          throw new InternalServerErrorException('Erreur interne lors de l\'inscription. Veuillez réessayer.');
        }

        // Désérialisation de la valeur JSON stockée dans PlatformSetting
        let launchPromoEndsAt: Date | null = null;
        if (launchPromoSetting) {
          const parsed: unknown = JSON.parse(launchPromoSetting.value);
          if (typeof parsed === 'string') {
            const d = new Date(parsed);
            // Rejeter les valeurs non-parsables (Invalid Date)
            if (!isNaN(d.getTime())) {
              launchPromoEndsAt = d;
            }
          }
        }

        const trialEndsAt = computeTrialPeriod(now, launchPromoEndsAt, starterPlan.trialDurationDays);

        const organization = await tx.organization.create({
          data: {
            name: dto.organizationName,
            subdomain: dto.subdomain,
            status: 'TRIALING',
            trialEndsAt,
          },
          select: { id: true, subdomain: true },
        });

        const adminRole = await tx.role.create({
          data: {
            organizationId: organization.id,
            name: 'administrateur',
            label: 'Administrateur',
            description: 'Rôle administrateur avec accès complet à toutes les fonctionnalités.',
            permissions: {
              create: allPermissions.map((p) => ({ permissionId: p.id })),
            },
          },
          select: { id: true },
        });

        const adminUser = await tx.user.create({
          data: {
            organizationId: organization.id,
            firstname: dto.adminFirstname,
            lastname: dto.adminLastname,
            email: dto.adminEmail,
            username: dto.adminEmail,
            password: hashedPassword,
            isActive: true,
          },
          select: { id: true },
        });

        await tx.roleOnUser.create({
          data: { userId: adminUser.id, roleId: adminRole.id },
        });

        // Création de la Subscription TRIALING dans la même transaction atomique
        await tx.subscription.create({
          data: {
            organizationId: organization.id,
            planId: starterPlan.id,
            status: 'TRIALING',
            currentPeriodEnd: trialEndsAt,
          },
        });

        return {
          organizationId: organization.id,
          subdomain: organization.subdomain,
          adminUserId: adminUser.id,
        };
      });
    } catch (e) {
      // Race condition : deux inscriptions simultanées avec le même sous-domaine.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ce sous-domaine n\'est pas disponible.');
      }
      throw e;
    }
  }
}
