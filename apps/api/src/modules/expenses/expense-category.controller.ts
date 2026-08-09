import {
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
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ExpenseCategoryService } from './expense-category.service';
import {
  CreateExpenseCategorySchema,
  UpdateExpenseCategorySchema,
} from './dto/create-expense-category.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD catégories de dépenses tenant (S29) — mirror exact de BrandsController.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('expense-categories')
export class ExpenseCategoryController {
  constructor(private readonly expenseCategoryService: ExpenseCategoryService) {}

  /** GET /api/v1/expense-categories — liste paginée des catégories actives de l'organisation. */
  @RequirePermission('expenseCategories.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.expenseCategoryService.findAll(req.user.organizationId, p, l);
  }

  /** GET /api/v1/expense-categories/:id — détail d'une catégorie de l'organisation. */
  @RequirePermission('expenseCategories.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenseCategoryService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/expense-categories — crée une catégorie de dépense (201). */
  @RequirePermission('expenseCategories.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'expenseCategories.create', entity: 'ExpenseCategory' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateExpenseCategorySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.expenseCategoryService.create(req.user.organizationId, req.user.id, result.data);
  }

  /** PATCH /api/v1/expense-categories/:id — modifie une catégorie de dépense. */
  @RequirePermission('expenseCategories.edit')
  @Patch(':id')
  @Auditable({ action: 'expenseCategories.update', entity: 'ExpenseCategory' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateExpenseCategorySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.expenseCategoryService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/expense-categories/:id — soft-delete d'une catégorie (204 No Content). */
  @RequirePermission('expenseCategories.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'expenseCategories.delete', entity: 'ExpenseCategory' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.expenseCategoryService.remove(id, req.user.organizationId);
  }
}
