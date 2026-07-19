import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { EncryptionService } from '../../common/encryption.service';
import type { SmtpServerDto, SmtpServerPublicDto } from './dto/smtp-server.dto';

/**
 * Gestion de la configuration SMTP par organisation.
 * Le mot de passe est chiffré avant toute écriture en base (§17 point S).
 * passwordCipher n'est jamais exposé dans les réponses HTTP.
 */
@Injectable()
export class SmtpServerService {
  private readonly logger = new Logger(SmtpServerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Crée ou remplace la configuration SMTP d'une organisation.
   * @returns Objet public sans passwordCipher ni mot de passe en clair.
   */
  async upsert(organizationId: string, dto: SmtpServerDto): Promise<SmtpServerPublicDto> {
    const passwordCipher = this.encryption.encrypt(dto.password);

    const record = await this.prisma.smtpServer.upsert({
      where: { organizationId },
      create: {
        organizationId,
        host: dto.host,
        port: dto.port,
        username: dto.username,
        passwordCipher,
        fromEmail: dto.fromEmail,
        fromName: dto.fromName,
      },
      update: {
        host: dto.host,
        port: dto.port,
        username: dto.username,
        passwordCipher,
        fromEmail: dto.fromEmail,
        fromName: dto.fromName,
      },
      select: {
        id: true,
        organizationId: true,
        host: true,
        port: true,
        username: true,
        fromEmail: true,
        fromName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Configuration SMTP mise à jour — org ${organizationId}`);
    return record;
  }

  /**
   * Retourne le mot de passe déchiffré — usage interne uniquement (email-queue).
   * Non exposé via controller.
   */
  async getDecryptedPassword(organizationId: string): Promise<string> {
    const record = await this.prisma.smtpServer.findUnique({
      where: { organizationId },
      select: { passwordCipher: true },
    });
    if (!record) {
      throw new NotFoundException(`Configuration SMTP introuvable pour l'organisation ${organizationId}`);
    }
    return this.encryption.decrypt(record.passwordCipher);
  }
}
