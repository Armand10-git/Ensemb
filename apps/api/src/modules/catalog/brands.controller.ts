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
import { BrandService } from './brand.service';
import { CreateBrandSchema, UpdateBrandSchema } from './dto/create-brand.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD marques tenant.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('catalog/brands')
export class BrandsController {
  constructor(private readonly brandService: BrandService) {}

  /** GET /api/v1/catalog/brands — liste paginée des marques actives de l'organisation. */
  @RequirePermission('brands.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.brandService.findAll(req.user.organizationId, p, l);
  }

  /** GET /api/v1/catalog/brands/:id — détail d'une marque de l'organisation. */
  @RequirePermission('brands.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.brandService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/catalog/brands — crée une marque (201). */
  @RequirePermission('brands.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'brands.create', entity: 'Brand' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateBrandSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.brandService.create(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/catalog/brands/:id — modifie une marque. */
  @RequirePermission('brands.edit')
  @Patch(':id')
  @Auditable({ action: 'brands.update', entity: 'Brand' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateBrandSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.brandService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/catalog/brands/:id — soft-delete d'une marque (204 No Content). */
  @RequirePermission('brands.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'brands.delete', entity: 'Brand' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.brandService.remove(id, req.user.organizationId);
  }
}
