import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';

/**
 * Module de génération PDF (S34). N'importe pas UploadsModule explicitement : il est
 * @Global() (cf. uploads.module.ts) et StorageService y est exporté depuis S34 — les workers
 * PDF l'injectent directement pour uploader le résultat de PdfService.render() sans second
 * client S3.
 *
 * Chargé uniquement dans WorkerModule (jamais dans AppModule) — mirror MessagingModule :
 * seuls les workers ont besoin de PdfService, les contrôleurs HTTP se contentent d'enfiler un
 * job via PdfQueueModule.
 */
@Module({
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
