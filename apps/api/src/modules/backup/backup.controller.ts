import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
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
  private readonly logger = new Logger(BackupController.name);

  constructor(private readonly backupService: BackupService) {}

  @Post('exports')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ action: 'BACKUP_EXPORT_REQUESTED', entity: 'BackupExport' })
  async requestExport(@Req() req: AuthenticatedRequest): Promise<{ exportId: string }> {
    const body: unknown = (req as { body?: unknown }).body;
    const result = RequestExportSchema.safeParse(body ?? {});
    if (!result.success) {
      throw new UnprocessableEntityException("Format d'export invalide.");
    }

    const { organizationId } = req.user;
    return this.backupService.requestExport(organizationId, result.data.format);
  }

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

    stream.on('error', (err) => {
      this.logger.error(`Erreur lecture stream export ${exportId}`, err);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });

    stream.pipe(res);
  }

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
