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
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { ProductService } from './product.service';
import {
  CreateProductSchema,
  UpdateProductSchema,
  CreateProductVariantSchema,
} from './dto/create-product.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD produits tenant.
 * Tous les endpoints exigent JwtAuthGuard + PermissionGuard.
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('catalog/products')
export class ProductsController {
  constructor(private readonly productService: ProductService) {}

  /**
   * GET /api/v1/catalog/products
   * Liste paginée et filtrée des produits actifs de l'organisation.
   * Chaque produit expose imageUrl (URL signée) — jamais la clé S3 brute.
   */
  @RequirePermission('products.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('brandId') brandId?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.productService.findAll(
      req.user.organizationId,
      p,
      l,
      search,
      categoryId,
      brandId,
    );
  }

  /** GET /api/v1/catalog/products/:id */
  @RequirePermission('products.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.productService.findOne(id, req.user.organizationId);
  }

  /** POST /api/v1/catalog/products — 201 */
  @RequirePermission('products.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'products.create', entity: 'Product' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateProductSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.productService.create(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/catalog/products/:id */
  @RequirePermission('products.edit')
  @Patch(':id')
  @Auditable({ action: 'products.update', entity: 'Product' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateProductSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.productService.update(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/catalog/products/:id — 204 */
  @RequirePermission('products.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'products.delete', entity: 'Product' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.productService.remove(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/catalog/products/:id/image
   * Upload multipart → clé S3 → URL signée retournée (jamais la clé brute).
   * 200 { imageUrl: "https://…" }
   */
  @RequirePermission('products.edit')
  @Post(':id/image')
  @Auditable({ action: 'products.uploadImage', entity: 'Product' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  uploadImage(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Le champ "file" est obligatoire.');
    }
    return this.productService.uploadImage(id, req.user.organizationId, file);
  }

  /** POST /api/v1/catalog/products/:id/variants — 201 */
  @RequirePermission('products.edit')
  @Post(':id/variants')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'products.createVariant', entity: 'ProductVariant' })
  createVariant(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = CreateProductVariantSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.productService.createVariant(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/catalog/products/:id/variants/:variantId — 204 */
  @RequirePermission('products.edit')
  @Delete(':id/variants/:variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'products.deleteVariant', entity: 'ProductVariant' })
  async removeVariant(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    await this.productService.removeVariant(id, variantId, req.user.organizationId);
  }
}
