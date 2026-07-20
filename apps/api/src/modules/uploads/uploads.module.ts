import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';

/**
 * Module global d'upload d'images (S13 — Bloc D).
 * @Global() permet à CatalogModule, OrganizationsModule et tous les autres
 * modules d'injecter UploadsService sans réimporter UploadsModule.
 *
 * Dépendances futures :
 *   - TODO S13: remplacer Brand.image URL externe par une clé S3 via UploadsService (CatalogModule)
 *   - TODO S13: remplacer Organization.logoUrl URL externe par une clé S3 via UploadsService (OrganizationsModule)
 *   - TODO S14: cache Redis TTL < TTL S3 sur les URLs signées si les listes de produits deviennent volumineuses
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [StorageService, UploadsService],
  controllers: [UploadsController],
  exports: [UploadsService],
})
export class UploadsModule {}
