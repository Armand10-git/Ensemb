import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ViewAllInterceptor, type ViewAllRequest } from '../../common/interceptors/view-all.interceptor';
import { CashSessionService } from './cash-session.service';
import { OpenCashSessionSchema, CloseCashSessionSchema } from './dto/cash-session.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CASH_SESSION_STATUSES = ['OPEN', 'CLOSED'];

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints de gestion des sessions de caisse (S23b — Bloc E, §18.2).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL ni du body (anti-IDOR).
 *
 * Routes :
 *   POST   /api/v1/cash-sessions/open        → 201 (ouverture, statut OPEN)
 *   GET    /api/v1/cash-sessions/current     → 200, session OPEN de l'appelant ou null
 *   PATCH  /api/v1/cash-sessions/:id/close   → 200 (clôture, calcul de l'écart)
 *   GET    /api/v1/cash-sessions             → liste paginée (records.viewAll via ViewAllInterceptor)
 *   GET    /api/v1/cash-sessions/:id         → détail avec sous-total des ventes rattachées
 *
 * NOTE d'ordre des routes : GET /current DOIT être déclaré avant GET /:id — Nest résout les
 * routes d'un même verbe dans l'ordre de déclaration, sinon "current" serait capturé par :id.
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('cash-sessions')
export class CashSessionController {
  constructor(private readonly cashSessionService: CashSessionService) {}

  /**
   * POST /api/v1/cash-sessions/open
   * Ouvre une session de caisse (fond de caisse déclaré) pour l'utilisateur courant.
   */
  @RequirePermission('cashsessions.open')
  @Post('open')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'cashsessions.open', entity: 'CashSession' })
  open(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = OpenCashSessionSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.cashSessionService.open(req.user.organizationId, req.user.id, result.data);
  }

  /**
   * GET /api/v1/cash-sessions/current?warehouseId=
   * Retourne la session OPEN de l'utilisateur courant pour l'entrepôt donné, ou null (200)
   * si aucune session n'est ouverte — pas de 204, décision produit validée pour ce endpoint.
   *
   * @Res() en mode non-passthrough est nécessaire ici : le reply controller de Nest traite
   * `return null` exactement comme `return undefined` (isNil) et envoie un corps VIDE, pas le
   * littéral JSON `null` — ce qui casserait `res.json()` côté client (SyntaxError sur corps
   * vide) au lieu de résoudre `null` proprement. On prend donc la main sur la réponse Express
   * pour forcer `res.json(session)`, qui sérialise correctement `null` en `"null"` sur le fil.
   */
  @RequirePermission('cashsessions.view')
  @Get('current')
  async current(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('warehouseId') warehouseId?: string,
  ): Promise<void> {
    if (!warehouseId || !UUID_RE.test(warehouseId)) {
      throw new BadRequestException('warehouseId doit être un UUID valide.');
    }
    const session = await this.cashSessionService.findCurrent(
      req.user.organizationId,
      req.user.id,
      warehouseId,
    );
    res.status(200).json(session);
  }

  /**
   * PATCH /api/v1/cash-sessions/:id/close
   * Clôture la session : comptage physique saisi par le caissier, écart calculé côté serveur.
   */
  @RequirePermission('cashsessions.close')
  @Patch(':id/close')
  @Auditable({ action: 'cashsessions.close', entity: 'CashSession' })
  close(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = CloseCashSessionSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.cashSessionService.close(
      id,
      req.user.organizationId,
      req.user.id,
      result.data,
    );
  }

  /**
   * GET /api/v1/cash-sessions
   * Liste paginée des sessions de caisse, filtrable par warehouseId et status.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll : si
   * absente, seules les sessions ouvertes par l'utilisateur sont retournées.
   */
  @RequirePermission('cashsessions.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('status') status?: string,
  ) {
    if (warehouseId !== undefined && !UUID_RE.test(warehouseId)) {
      throw new BadRequestException('warehouseId doit être un UUID valide.');
    }

    const { page: p, limit: l } = parsePagination(page, limit);
    const validStatus = CASH_SESSION_STATUSES.includes(String(status)) ? status : undefined;

    return this.cashSessionService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      warehouseId,
      validStatus,
    );
  }

  /**
   * GET /api/v1/cash-sessions/:id
   * Retourne le détail d'une session avec le sous-total des ventes rattachées.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll : sans elle,
   * un caissier ne peut consulter le détail que de SA propre session (§ revue sécurité S23b —
   * même règle d'accès que la clôture, pas seulement l'isolation d'organisation).
   */
  @RequirePermission('cashsessions.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get(':id')
  findOne(@Req() req: ViewAllRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.cashSessionService.findOne(id, req.user.organizationId, req.user.id, req.viewAll);
  }
}
