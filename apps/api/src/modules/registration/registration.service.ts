import { ConflictException, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { RegisterOrganizationDto } from './dto/register-organization.dto';
import { RESERVED_SUBDOMAINS } from './dto/register-organization.dto';

/**
 * Durée d'essai standard en jours.
 * DETTE T06 : remplacer par Plan.trialDurationDays et vérifier
 * PlatformSetting.launchPromoEndsAt pour la fenêtre de lancement (§17 point R).
 */
const DEFAULT_TRIAL_DAYS = 30;

/** Coût bcrypt pour le hash du mot de passe administrateur (identique à AuthService). */
const BCRYPT_ROUNDS = 12;

export interface RegistrationResult {
  organizationId: string;
  subdomain: string;
  adminUserId: string;
}

/**
 * Calcule la date de fin d'essai à partir d'un instant donné.
 * Fonction pure exportée pour être testée indépendamment du service.
 * DETTE T06 : ajouter la branche fenêtre de lancement (launchPromoEndsAt).
 */
export function computeTrialEndsAt(now: Date, trialDays = DEFAULT_TRIAL_DAYS): Date {
  return new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
}

/**
 * Gère l'inscription d'une nouvelle organisation (tenant).
 * Toutes les créations se font dans une transaction atomique :
 * Organization + User admin + Role "Administrateur" + assignation.
 */
@Injectable()
export class RegistrationService {
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
   * 1. Organization (status TRIALING, trialEndsAt calculé)
   * 2. Role "Administrateur" avec toutes les permissions du catalogue global
   * 3. User admin (bcrypt cost 12)
   * 4. Assignation du rôle à l'utilisateur
   *
   * Si n'importe quelle étape échoue, tout est rollbacké — aucune création partielle.
   * Le catch P2002 (violation de contrainte unique) protège contre la race condition
   * entre la vérification de disponibilité hors-transaction et la création.
   */
  async register(dto: RegisterOrganizationDto): Promise<RegistrationResult> {
    const { available } = await this.checkSubdomainAvailability(dto.subdomain);
    if (!available) {
      throw new ConflictException('Ce sous-domaine n\'est pas disponible.');
    }

    const hashedPassword = await bcrypt.hash(dto.adminPassword, BCRYPT_ROUNDS);
    const trialEndsAt = computeTrialEndsAt(new Date());

    try {
      return await this.prisma.$transaction(async (tx) => {
        const allPermissions = await tx.permission.findMany({ select: { id: true } });

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
            // username = email à la création ; modifiable par l'admin en T05+
            username: dto.adminEmail,
            password: hashedPassword,
            isActive: true,
          },
          select: { id: true },
        });

        await tx.roleOnUser.create({
          data: { userId: adminUser.id, roleId: adminRole.id },
        });

        return {
          organizationId: organization.id,
          subdomain: organization.subdomain,
          adminUserId: adminUser.id,
        };
      });
    } catch (e) {
      // Race condition : deux inscriptions simultanées avec le même sous-domaine.
      // La contrainte unique `organizations.subdomain` renvoie P2002 — on la traduit
      // en ConflictException avec le même message neutre (anti-énumération).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ce sous-domaine n\'est pas disponible.');
      }
      throw e;
    }
  }
}
