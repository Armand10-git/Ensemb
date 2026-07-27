import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { PosService } from './pos.service';
import { CalculateTotalSchema, CreatePosSaleSchema } from './dto/pos-sale.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Endpoints du parcours vente au comptoir (S22 — Bloc E, §18.2).
 * Toutes les routes exigent JwtAuthGuard + PermissionGuard + `sales.create`.
 * organizationId est toujours extrait de req.user — jamais de l'URL/du body (anti-IDOR).
 *
 * Routes :
 *   GET  /api/v1/pos/products/search    → recherche produit + stock live (nom, code, scan)
 *   POST /api/v1/pos/calculate-total    → recalcul serveur, ne persiste rien
 *   POST /api/v1/pos/sales              → 201, création atomique (stock + paiement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('pos')
export class PosController {
  constructor(private readonly posService: PosService) {}

  /**
   * GET /api/v1/pos/products/search?q=&warehouseId=
   * Sert aussi bien la recherche texte que le scan douchette (le scanner tape le code
   * dans le même champ recherche + Entrée, §17 point D — pas d'endpoint /scan séparé).
   */
  @RequirePermission('sales.create')
  @Get('products/search')
  search(
    @Req() req: AuthenticatedRequest,
    @Query('warehouseId') warehouseId?: string,
    @Query('q') q?: string,
  ) {
    if (!warehouseId || !UUID_RE.test(warehouseId)) {
      throw new BadRequestException('warehouseId doit être un UUID valide.');
    }
    return this.posService.searchProducts(req.user.organizationId, warehouseId, q);
  }

  /**
   * POST /api/v1/pos/calculate-total
   * Recalcule le total côté serveur à partir des lignes envoyées — aucune persistence.
   * Utilisé par le panier pendant que le caissier ajuste les quantités.
   */
  @RequirePermission('sales.create')
  @Post('calculate-total')
  @HttpCode(HttpStatus.OK)
  calculateTotal(@Body() body: unknown) {
    const result = CalculateTotalSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.posService.calculateTotal(result.data);
  }

  /**
   * POST /api/v1/pos/sales
   * Crée une vente POS en une seule transaction : recalcul serveur du total (ignore tout
   * total envoyé par le client), décrément de stock, paiement immédiat (CASH/CARD) ou
   * mise en attente mobile money (AWAITING_PAYMENT + job d'expiration).
   */
  @RequirePermission('sales.create')
  @Post('sales')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'pos.createSale', entity: 'Sale' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreatePosSaleSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.posService.createSale(req.user.organizationId, req.user.id, result.data);
  }
}
