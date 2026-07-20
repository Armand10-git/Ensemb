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
import { CategoryService } from './catalog.service';
import { CreateCategorySchema, UpdateCategorySchema } from './dto/create-category.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD catégories tenant.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categoryService: CategoryService) {}

  /** GET /api/v1/catalog/categories — liste paginée des catégories actives de l'organisation. */
  @RequirePermission('categories.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.categoryService.findAll(req.user.organizationId, p, l);
  }

  /** GET /api/v1/catalog/categories/:id — détail d'une catégorie de l'organisation. */
  @RequirePermission('categories.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.categoryService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/catalog/categories — crée une catégorie (201). */
  @RequirePermission('categories.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'categories.create', entity: 'Category' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateCategorySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.categoryService.create(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/catalog/categories/:id — modifie une catégorie. */
  @RequirePermission('categories.edit')
  @Patch(':id')
  @Auditable({ action: 'categories.update', entity: 'Category' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateCategorySchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.categoryService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/catalog/categories/:id — soft-delete d'une catégorie (204 No Content). */
  @RequirePermission('categories.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'categories.delete', entity: 'Category' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.categoryService.remove(id, req.user.organizationId);
  }
}
