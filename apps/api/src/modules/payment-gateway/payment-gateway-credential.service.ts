import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import type {
  PaymentGatewayCredentialDto,
  PaymentGatewayCredentialPublicDto,
} from './dto/payment-gateway-credential.dto';

/**
 * Gestion des identifiants d'agrégateur de paiement (CARD/Orange Money/MTN MoMo) PAR
 * ORGANISATION (S31, §17 point S). Un seul compte agrégateur par tenant : apiKey et
 * webhookSecret sont chiffrés avant toute écriture en base ; apiKeyCipher et
 * webhookSecretCipher ne sont jamais exposés dans les réponses HTTP.
 */
@Injectable()
export class PaymentGatewayCredentialService {
  private readonly logger = new Logger(PaymentGatewayCredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Crée ou remplace les identifiants d'agrégateur de paiement d'une organisation.
   * @param organizationId Tenant propriétaire — jamais issu du body/params (anti-IDOR).
   * @param dto Identifiants en clair (apiKey, merchantId, webhookSecret, isActive).
   * @returns Objet public sans apiKeyCipher ni webhookSecretCipher.
   */
  async upsert(
    organizationId: string,
    dto: PaymentGatewayCredentialDto,
  ): Promise<PaymentGatewayCredentialPublicDto> {
    const apiKeyCipher = this.encryption.encrypt(dto.apiKey);
    const webhookSecretCipher = this.encryption.encrypt(dto.webhookSecret);
    // Champs partagés entre create et update — spreading d'un objet local typé (pas du body)
    const fields = {
      apiKeyCipher,
      merchantId: dto.merchantId ?? null,
      webhookSecretCipher,
      isActive: dto.isActive ?? true,
    };

    const record = await this.prisma.paymentGatewayCredential.upsert({
      where: { organizationId },
      create: { organizationId, ...fields },
      update: fields,
      select: {
        id: true,
        organizationId: true,
        merchantId: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Identifiants agrégateur de paiement mis à jour — org ${organizationId}`);
    return record;
  }

  /**
   * Retourne les identifiants d'agrégateur (hors secrets) d'une organisation, ou `null`
   * si aucune configuration n'existe — cette méthode ne lève JAMAIS d'exception : c'est à
   * l'appelant (ex. écran de paramètres) de décider du comportement selon l'absence de
   * configuration.
   */
  async findForOrg(organizationId: string): Promise<{
    merchantId: string | null;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    const record = await this.prisma.paymentGatewayCredential.findUnique({
      where: { organizationId },
      select: { merchantId: true, isActive: true, createdAt: true, updatedAt: true },
    });
    return record ?? null;
  }

  /**
   * Retourne les identifiants déchiffrés — usage interne uniquement (sera consommé par
   * TenantPaymentGatewayService, S31 agent suivant). Non exposé via controller.
   *
   * Contrairement à SmtpServerService.getDecryptedPassword() qui lève une exception si la
   * configuration est absente, cette méthode retourne `null` sans jamais lever — à la fois
   * si aucune configuration n'existe ET si `isActive` est `false`. C'est ce qui permet à
   * l'appelant de basculer en "mode test" plutôt que d'échouer bruyamment lorsque
   * l'organisation n'a pas (ou plus) activé son agrégateur de paiement.
   */
  async getDecryptedCredential(organizationId: string): Promise<{
    apiKey: string;
    merchantId: string | null;
    webhookSecret: string;
  } | null> {
    const record = await this.prisma.paymentGatewayCredential.findUnique({
      where: { organizationId },
      select: { apiKeyCipher: true, merchantId: true, webhookSecretCipher: true, isActive: true },
    });
    if (!record || !record.isActive) {
      return null;
    }
    return {
      apiKey: this.encryption.decrypt(record.apiKeyCipher),
      merchantId: record.merchantId,
      webhookSecret: this.encryption.decrypt(record.webhookSecretCipher),
    };
  }
}
