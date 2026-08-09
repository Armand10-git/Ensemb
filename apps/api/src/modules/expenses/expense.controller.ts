import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ViewAllInterceptor, type ViewAllRequest } from '../../common/interceptors/view-all.interceptor';
import { ExpenseService } from './expense.service';
import { CreateExpenseSchema, UpdateExpenseSchema } from './dto/create-expense.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * Endpoints CRUD des dépenses (S29) — entité plate, aucun cycle de vie (pas de
 * validate/cancel/convert, contrairement à SaleController/QuotationController).
 *
 * Toutes les routes sont protégées JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 *
 * Routes :
 *   GET    /api/v1/expenses     → liste paginée (records.viewAll via ViewAllInterceptor)
 *   POST   /api/v1/expenses     → 201 (référence DEP-YYYY-NNNNNN générée côté serveur)
 *   GET    /api/v1/expenses/:id → détail
 *   PATCH  /api/v1/expenses/:id → 200 (aucune restriction de statut)
 *   DELETE /api/v1/expenses/:id → 204 (soft delete uniquement)
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('expenses')
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  /**
   * GET /api/v1/expenses
   * Liste paginée des dépenses, filtrable par expenseCategoryId, warehouseId, date.
   * ViewAllInterceptor injecte request.viewAll selon la permission records.viewAll :
   * si absente, seules les dépenses créées par l'utilisateur sont retournées.
   */
  @RequirePermission('expenses.view')
  @UseInterceptors(ViewAllInterceptor)
  @Get()
  findAll(
    @Req() req: ViewAllRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('expenseCategoryId') expenseCategoryId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('date') date?: string,
  ) {
    if (expenseCategoryId !== undefined && !UUID_RE.test(expenseCategoryId)) {
      throw new BadRequestException('expenseCategoryId doit être un UUID valide.');
    }
    if (warehouseId !== undefined && !UUID_RE.test(warehouseId)) {
      throw new BadRequestException('warehouseId doit être un UUID valide.');
    }

    const { page: p, limit: l } = parsePagination(page, limit);

    return this.expenseService.findAll(
      req.user.organizationId,
      req.user.id,
      req.viewAll,
      p,
      l,
      expenseCategoryId,
      warehouseId,
      date,
    );
  }

  /**
   * POST /api/v1/expenses
   * Crée une dépense — référence générée côté serveur (DocumentType.EXPENSE).
   * Pas de @Auditable ici : convention des modules documentaires (S19/S24/S28) — seules
   * update/remove sont journalisées.
   */
  @RequirePermission('expenses.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateExpenseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.expenseService.create(req.user.organizationId, req.user.id, result.data);
  }

  /** GET /api/v1/expenses/:id — détail d'une dépense de l'organisation. */
  @RequirePermission('expenses.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenseService.findOne(id, req.user.organizationId);
  }

  /** PATCH /api/v1/expenses/:id — modifie une dépense (aucune restriction de statut). */
  @RequirePermission('expenses.edit')
  @Patch(':id')
  @Auditable({ action: 'expenses.update', entity: 'Expense' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateExpenseSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.expenseService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/expenses/:id — soft-delete d'une dépense (204 No Content). */
  @RequirePermission('expenses.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'expenses.delete', entity: 'Expense' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.expenseService.remove(id, req.user.organizationId);
  }
}
