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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadedFile } from '@nestjs/common';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { PartnersService } from './partners.service';
import { CreateClientSchema, UpdateClientSchema } from './dto/create-client.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

function parsePagination(page: unknown, limit: unknown) {
  const p = Math.max(1, parseInt(String(page ?? '1'), 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(String(limit ?? '20'), 10) || 20));
  return { page: p, limit: l };
}

/**
 * CRUD clients tenant + import CSV + export Excel.
 * organizationId extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('partners/clients')
export class ClientsController {
  constructor(private readonly partners: PartnersService) {}

  /** GET /api/v1/partners/clients — liste paginée + recherche. */
  @RequirePermission('customers.view')
  @Get()
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const { page: p, limit: l } = parsePagination(page, limit);
    return this.partners.findAllClients(req.user.organizationId, p, l, search);
  }

  /** GET /api/v1/partners/clients/template — modèle CSV téléchargeable. */
  @RequirePermission('customers.view')
  @Get('template')
  getTemplate(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clients-template.csv"');
    res.send(this.partners.getCsvTemplate());
  }

  /** GET /api/v1/partners/clients/export/excel — demande d'export asynchrone (202). */
  @RequirePermission('customers.view')
  @Get('export/excel')
  @HttpCode(HttpStatus.ACCEPTED)
  requestExport(@Req() req: AuthenticatedRequest) {
    return this.partners.requestExcelExport(req.user.organizationId, 'clients');
  }

  /** GET /api/v1/partners/clients/export/download/:filename — télécharge le fichier généré. */
  @RequirePermission('customers.view')
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

  /** GET /api/v1/partners/clients/:id — détail d'un client. */
  @RequirePermission('customers.view')
  @Get(':id')
  findOne(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.partners.findOneClient(id, req.user.organizationId);
  }

  /** POST /api/v1/partners/clients — crée un client (201). */
  @RequirePermission('customers.create')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'customers.create', entity: 'Client' })
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const result = CreateClientSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.partners.createClient(req.user.organizationId, result.data);
  }

  /** PATCH /api/v1/partners/clients/:id — modifie un client. */
  @RequirePermission('customers.edit')
  @Patch(':id')
  @Auditable({ action: 'customers.update', entity: 'Client' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const result = UpdateClientSchema.safeParse(body);
    if (!result.success) {
      throw new UnprocessableEntityException(result.error.flatten().fieldErrors);
    }
    return this.partners.updateClient(id, req.user.organizationId, result.data);
  }

  /** DELETE /api/v1/partners/clients/:id — soft-delete d'un client (204). */
  @RequirePermission('customers.delete')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Auditable({ action: 'customers.delete', entity: 'Client' })
  async remove(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.partners.removeClient(id, req.user.organizationId);
  }

  /**
   * POST /api/v1/partners/clients/import — import CSV multipart.
   * MIME vérifié par multer fileFilter + contrôle des octets réels dans le handler.
   * Taille max : 5 Mo.
   */
  @RequirePermission('customers.import')
  @Post('import')
  @Auditable({ action: 'customers.import', entity: 'Client' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        // Premier filtre sur le MIME déclaré — le buffer est re-vérifié dans le handler
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

    // Vérification des octets réels : les 512 premiers octets ne doivent pas contenir
    // de bytes nuls (signature binaire) — les CSV sont du texte pur
    const probe = file.buffer.slice(0, 512);
    if (probe.includes(0x00)) {
      throw new UnprocessableEntityException('Le fichier ne semble pas être un CSV valide.');
    }

    return this.partners.importFromCsv(req.user.organizationId, 'clients', file.buffer);
  }
}
