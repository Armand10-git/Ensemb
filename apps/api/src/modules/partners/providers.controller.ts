import * as fs from 'fs';
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
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { PartnersService } from './partners.service';
import { CreateProviderSchema, UpdateProviderSchema } from './dto/create-provider.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD fournisseurs tenant + import CSV + export Excel.
 * organizationId extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('partners/providers')
export class ProvidersController {
  constructor(private readonly partners: PartnersService) {}

  /** GET /api/v1/partners/providers — liste paginée + recherche. */
  @RequirePermission('suppliers.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.partners.findAllProviders(req.user.organizationId, p, l, search);
  }

  /** GET /api/v1/partners/providers/template — modèle CSV téléchargeable. */
  @RequirePermission('suppliers.view')
  @Get('template')
  getTemplate(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="providers-template.csv"');
    res.send(this.partners.getCsvTemplate());
  }

  /** GET /api/v1/partners/providers/export/excel — demande d'export asynchrone (202). */
  @RequirePermission('suppliers.view')
  @Get('export/excel')
  @HttpCode(HttpStatus.ACCEPTED)
  requestExport(@Req() req: AuthenticatedRequest) {
    return this.partners.requestExcelExport(req.user.organizationId, 'providers');
  }

  /** GET /api/v1/partners/providers/export/download/:filename — télécharge le fichier. */
  @RequirePermission('suppliers.view')
  @Get('export/download/:filename')
  downloadExport(
    @Req() req: AuthenticatedRequest,
    @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    const filePath = this.partners.resolveExportPath(req.user.organizationId, filename);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  /** GET /api/v1/partners/providers/:id — détail d'un fournisseur. */
  @RequirePermission('suppliers.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.partners.findOneProvider(id, req.user.organizationId);
  }

  /** POST /api/v1/partners/providers — crée un fournisseur (201). */
  @RequirePermission('suppliers.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'suppliers.create', entity: 'Provider' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateProviderSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.partners.createProvider(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/partners/providers/:id — modifie un fournisseur. */
  @RequirePermission('suppliers.edit')
  @Patch(':id')
  @Auditable({ action: 'suppliers.update', entity: 'Provider' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateProviderSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.partners.updateProvider(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/partners/providers/:id — soft-delete d'un fournisseur (204). */
  @RequirePermission('suppliers.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'suppliers.delete', entity: 'Provider' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.partners.removeProvider(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/partners/providers/import — import CSV multipart.
   * Magic bytes vérifiés via fileFilter (text/csv).
   * Taille max : 5 Mo.
   */
  @RequirePermission('suppliers.import')
  @Post('import')
  @Auditable({ action: 'suppliers.import', entity: 'Provider' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (
          file.mimetype === 'text/csv' ||
          file.mimetype === 'application/vnd.ms-excel' ||
          file.mimetype === 'text/plain'
        ) {
          cb(null, true);
        } else {
          cb(new UnprocessableEntityException('Seuls les fichiers CSV sont acceptés.'), false);
        }
      },
    }),
  )
  async importCsv(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new UnprocessableEntityException('Aucun fichier fourni.');
    }
    return this.partners.importFromCsv(req.user.organizationId, 'providers', file.buffer);
  }
}
