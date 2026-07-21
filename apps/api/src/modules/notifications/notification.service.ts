import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { PaginatedResult } from '../../common/types';

export interface LowAlertPayload {
  productId: string;
  productName: string;
  currentQuantity: unknown; // Decimal sérialisé en string côté JSON
  threshold: number;
  warehouseId: string;
}

/**
 * Gestion des notifications persistantes (S18 — §17 point I).
 *
 * Motivation : Socket.io `stock:lowAlert` est volatile ; si aucun client n'est
 * connecté au moment de l'émission, l'alerte est perdue. Ce service la persiste
 * en base pour que l'utilisateur la retrouve à sa prochaine connexion.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Crée une notification pour chaque utilisateur actif de l'organisation
   * ayant la permission `permission`, puis émet `notification:new` sur leur
   * room personnelle Socket.io.
   *
   * Ne lève pas d'exception si aucun utilisateur n'a la permission (cas normal
   * en démo). Doit être appelé APRÈS que la transaction métier a été commitée.
   *
   * @param organizationId - Tenant scopé (anti-IDOR)
   * @param type - Catégorie machine-readable ("stock.lowAlert", …)
   * @param payload - Données spécifiques au type
   * @param permission - Permission requise pour recevoir la notification
   */
  async createForOrg(
    organizationId: string,
    type: string,
    payload: Record<string, unknown>,
    permission: string,
  ): Promise<void> {
    // Trouve les utilisateurs actifs du tenant ayant la permission via leurs rôles
    const recipients = await this.prisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        deletedAt: null,
        roles: {
          some: {
            role: {
              organizationId,
              status: true,
              permissions: {
                some: {
                  permission: { name: permission },
                },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    if (recipients.length === 0) return;

    const now = new Date();
    const data = recipients.map((u) => ({
      organizationId,
      userId: u.id,
      type,
      payload: payload as Prisma.InputJsonObject,
      createdAt: now,
    }));

    // createMany ne retourne pas les ids sous PostgreSQL — on relit ensuite
    await this.prisma.notification.createMany({ data });

    // Émet notification:new sur la room personnelle de chaque destinataire
    for (const u of recipients) {
      this.realtime.server
        .to(`org:${organizationId}:user:${u.id}`)
        .emit('notification:new', { type, payload, createdAt: now.toISOString() });
    }
  }

  /**
   * Retourne la liste paginée des notifications de l'utilisateur, triée par
   * createdAt décroissant. `unreadOnly` filtre sur readAt IS NULL.
   *
   * @param organizationId - Scoping tenant
   * @param userId - Scoping utilisateur (anti-IDOR)
   * @param page - Numéro de page (≥ 1)
   * @param limit - Taille de page (1–100)
   * @param unreadOnly - Si vrai, retourne uniquement les non-lues
   */
  async findAll(
    organizationId: string,
    userId: string,
    page: number,
    limit: number,
    unreadOnly = false,
  ): Promise<PaginatedResult<Notification>> {
    const where = {
      organizationId,
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  /**
   * Marque une notification comme lue en posant `readAt = now()`.
   * Vérifie que la notification appartient à l'utilisateur (anti-IDOR).
   *
   * @throws NotFoundException si la notification n'existe pas dans ce tenant
   * @throws ForbiddenException si elle appartient à un autre utilisateur
   */
  async markAsRead(id: string, organizationId: string, userId: string): Promise<Notification> {
    const notif = await this.prisma.notification.findFirst({
      where: { id, organizationId },
    });

    if (!notif) throw new NotFoundException('Notification introuvable.');
    if (notif.userId !== userId) throw new ForbiddenException('Accès refusé.');

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  /**
   * Marque toutes les notifications non lues de l'utilisateur comme lues.
   * Scopé par organizationId + userId — aucune fuite inter-tenant possible.
   *
   * @returns Nombre de notifications mises à jour
   */
  async markAllAsRead(organizationId: string, userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { organizationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  /**
   * Compte les notifications non lues de l'utilisateur.
   * Utilisé par le badge dans la navbar.
   *
   * @param organizationId - Scoping tenant
   * @param userId - Scoping utilisateur
   */
  async countUnread(organizationId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { organizationId, userId, readAt: null },
    });
  }
}
