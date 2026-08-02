import { Module } from '@nestjs/common';
import { SmtpModule } from '../smtp/smtp.module';
import { EmailService } from './email.service';
import { SmsService } from './sms.service';

/**
 * Module d'envoi de messages transactionnels — récapitulatif de vente par email/SMS (S24).
 * Séparé de apps/api/src/modules/notifications/ (notifications persistantes in-app, S18,
 * sans rapport) — décision actée S24.
 *
 * Importe SmtpModule pour SmtpServerService (config SMTP par organisation, EmailService).
 * ConfigService (identifiants Twilio plateforme, SmsService) est disponible sans import
 * explicite : ConfigModule.forRoot({ isGlobal: true }) est déclaré une seule fois dans
 * AppModule/WorkerModule — patron identique à BillingModule/PaymentAggregatorService.
 */
@Module({
  imports: [SmtpModule],
  providers: [EmailService, SmsService],
  exports: [EmailService, SmsService],
})
export class MessagingModule {}
