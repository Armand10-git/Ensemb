import {
  Controller,
  Post,
  Get,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UploadsService } from './uploads.service';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';

const ALLOWED_TYPES = ['products', 'brands', 'logos', 'avatars'] as const;
type ImageType = (typeof ALLOWED_TYPES)[number];

/**
 * Gestion des uploads d'images pour l'organisation courante.
 * - POST /api/v1/uploads/images  : upload + re-encodage → clé S3
 * - GET  /api/v1/uploads/images/signed-url : génère une URL pré-signée à partir de la clé
 *
 * La clé S3 est la seule chose persistée en base ; l'URL signée est éphémère et
 * générée à la volée à chaque lecture (§17 point Y).
 */
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploadsService: UploadsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * POST /api/v1/uploads/images
   * Body : multipart/form-data — champ "file" (image) + champ "type" (products|brands|logos|avatars).
   * Répond 201 avec { s3Key } — jamais l'URL signée (éphémère).
   */
  @Post('images')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // jamais diskStorage en multi-instance
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo (sécurité au niveau transport)
    }),
  )
  async uploadImage(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('type') type?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Champ "file" manquant dans la requête multipart');
    }

    if (!type || !(ALLOWED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        `Paramètre "type" invalide — valeurs acceptées : ${ALLOWED_TYPES.join(', ')}`,
      );
    }

    const s3Key = await this.uploadsService.uploadImage(
      req.user.organizationId,
      type as ImageType,
      file,
    );

    return { s3Key };
  }

  /**
   * GET /api/v1/uploads/images/signed-url?key=<s3Key>
   * Vérifie que la clé appartient à l'organisation (préfixe) — IDOR.
   * Répond 200 avec { url, expiresIn }.
   */
  @Get('images/signed-url')
  async getSignedUrl(
    @Req() req: AuthenticatedRequest,
    @Query('key') key?: string,
  ) {
    if (!key) {
      throw new BadRequestException('Paramètre "key" manquant');
    }

    // Vérification IDOR : la clé doit commencer par l'orgId du tenant courant
    if (!key.startsWith(`${req.user.organizationId}/`)) {
      throw new ForbiddenException(
        'Accès refusé — cette clé n\'appartient pas à votre organisation',
      );
    }

    const url = await this.uploadsService.getSignedUrl(key);
    const expiresIn = parseInt(this.config.get<string>('S3_SIGNED_URL_TTL', '3600'), 10);

    return { url, expiresIn };
  }
}
