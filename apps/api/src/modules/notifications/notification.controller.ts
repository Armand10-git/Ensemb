import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { NotificationService } from './notification.service';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints de lecture et marquage des notifications (S18 — §17 point I).
 *
 * organizationId et userId sont toujours extraits du JWT — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/notifications                → liste paginée (permission reports.quantityAlerts)
 *   GET    /api/v1/notifications/unread-count   → { count: number }
 *   PATCH  /api/v1/notifications/:id/read       → marquer une notification comme lue
 *   PATCH  /api/v1/notifications/read-all       → tout marquer comme lu
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * GET /api/v1/notifications
   * Liste paginée des notifications de l'utilisateur.
   * `?unreadOnly=true` filtre sur les non-lues uniquement.
   */
  @RequirePermission('reports.quantityAlerts')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.notificationService.findAll(
      req.user.organizationId,
      req.user.id,
      p,
      l,
      unreadOnly === 'true',
    );
  }

  /**
   * GET /api/v1/notifications/unread-count
   * Nombre de notifications non lues — alimente le badge navbar.
   * Accessible sans permission dédiée (tout utilisateur authentifié).
   */
  @Get('unread-count')
  async countUnread(@Req() req: AuthenticatedRequest): Promise<{ count: number }> {
    const count = await this.notificationService.countUnread(
      req.user.organizationId,
      req.user.id,
    );
    return { count };
  }

  /**
   * PATCH /api/v1/notifications/read-all
   * Marque toutes les notifications non lues de l'utilisateur comme lues.
   * Accessible sans permission dédiée (tout utilisateur marque ses propres notifications).
   */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@Req() req: AuthenticatedRequest): Promise<{ updated: number }> {
    const updated = await this.notificationService.markAllAsRead(
      req.user.organizationId,
      req.user.id,
    );
    return { updated };
  }

  /**
   * PATCH /api/v1/notifications/:id/read
   * Marque une notification comme lue. Vérifie ownership (anti-IDOR).
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markAsRead(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationService.markAsRead(id, req.user.organizationId, req.user.id);
  }
}
