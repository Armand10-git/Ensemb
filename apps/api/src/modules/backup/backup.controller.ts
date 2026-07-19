import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Auditable } from '../audit/auditable.decorator';
import { BackupService } from './backup.service';
import { RequestExportSchema } from './dto/request-export.dto';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import type { PaginatedResult, BackupExportSummary } from './backup.service';

/**
 * Endpoints de gestion des exports de données (T09 — §17 point N).
 * organizationId est toujours extrait de req.user — jamais de l'URL (anti-IDOR).
 */
@Controller('backup')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission('backup.manage')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  /**
   * POST /api/v1/backup/exports
   * Demande la génération d'un export CSV ou JSON en arrière-plan.
   * Répond 201 avec { exportId }.
   */
  @Post('exports')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'BACKUP_EXPORT_REQUESTED', entity: 'BackupExport' })
  async requestExport(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<{ exportId: string }> {
    const body: unknown = (req as { body?: unknown }).body;
    const result = RequestExportSchema.safeParse(body ?? {});
    if (!result.success) {
      throw new UnprocessableEntityException("Format d'export invalide.");
    }

    const { organizationId } = req.user;
    return this.backupService.requestExport(organizationId, result.data.format);
  }

  /**
   * GET /api/v1/backup/exports
   * Liste les exports de l'organisation avec pagination.
   * Répond 200 avec PaginatedResult<BackupExportSummary>.
   */
  @Get('exports')
  async listExports(
    @Req() req: AuthenticatedRequest,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ): Promise<PaginatedResult<BackupExportSummary>> {
    const { organizationId } = req.user;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    return this.backupService.listExports(organizationId, pageNum, limitNum);
  }

  /**
   * GET /api/v1/backup/exports/:id/download
   * Télécharge le fichier export via un ReadStream.
   * Ne retourne jamais le chemin absolu côté client.
   */
  @Get('exports/:id/download')
  async downloadExport(
    @Param('id') exportId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { organizationId } = req.user;
    const { stream, filename, mimeType } = await this.backupService.getDownloadStream(
      exportId,
      organizationId,
    );

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    stream.pipe(res);
  }

  /**
   * DELETE /api/v1/backup/exports/:id
   * Supprime un export (fichier physique + ligne BDD). Répond 204.
   */
  @Delete('exports/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteExport(
    @Param('id') exportId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    const { organizationId } = req.user;
    await this.backupService.deleteExport(exportId, organizationId);
  }
}
