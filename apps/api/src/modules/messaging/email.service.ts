import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SmtpServerService } from '../smtp/smtp-server.service';

/** Paramètres d'envoi d'un email — le corps HTML est déjà rendu par l'appelant. */
export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Envoi d'emails transactionnels (récapitulatif de vente, S24) via la configuration
 * SMTP propre à chaque organisation (SmtpServerService, S23bis).
 *
 * Mode test — aucun envoi réel :
 *   - NODE_ENV=test : jamais d'appel réseau ni de lecture de configuration SMTP (les
 *     tests d'intégration ne dépendent pas d'une base de données SMTP configurée) ;
 *   - hors NODE_ENV=test mais aucune configuration SMTP pour l'organisation : une
 *     BadRequestException explicite est levée (§ « erreurs actionnables », docs/ux/standards.md)
 *     plutôt qu'un envoi silencieusement ignoré — un administrateur qui clique sur
 *     « Envoyer par email » sans avoir configuré de serveur SMTP doit être informé,
 *     pas laissé croire que l'email est parti.
 *
 * Ce découplage NODE_ENV / configuration-absente diffère légèrement de la formulation
 * du patron PaymentAggregatorService (qui fond les deux conditions dans un seul
 * isTestMode « silencieux », sans jamais lever d'erreur) : ici, isTestMode ne couvre
 * QUE NODE_ENV=test ; l'absence de configuration SMTP hors tests est un cas d'erreur
 * distinct et explicite. C'est la seule lecture qui rend cohérentes les deux consignes
 * de la session S24 (« mode test → log » et « hors mode test, config absente → erreur
 * claire ») et qui permet d'écrire un test qui déclenche réellement cette erreur.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly isTestMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly smtpServerService: SmtpServerService,
  ) {
    this.isTestMode = this.config.get<string>('NODE_ENV') === 'test';
  }

  /**
   * Envoie un récapitulatif de vente par email au destinataire fourni.
   *
   * @param organizationId - Organisation dont la configuration SMTP est utilisée.
   * @param params - Destinataire, sujet et corps HTML déjà rendus (cf. sale-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais de secret journalisé).
   * @throws BadRequestException si, hors mode test, aucune configuration SMTP n'existe pour
   *         l'organisation, ou si l'envoi via le serveur SMTP échoue.
   */
  async sendSaleSummary(organizationId: string, params: SendEmailParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi d'email simulé (mode test) — destinataire=${params.to}, sujet="${params.subject}"`,
      );
      return;
    }

    const smtpConfig = await this.smtpServerService.findForOrg(organizationId);
    if (!smtpConfig) {
      throw new BadRequestException(
        "Aucun serveur SMTP n'est configuré pour cette organisation. " +
          'Configurez-en un avant d\'envoyer un email.',
      );
    }

    // Mot de passe déchiffré à la volée, jamais journalisé ni conservé au-delà de cet appel.
    const password = await this.smtpServerService.getDecryptedPassword(organizationId);

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.username,
        pass: password,
      },
    });

    try {
      await transporter.sendMail({
        from: `${smtpConfig.fromName} <${smtpConfig.fromEmail}>`,
        to: params.to,
        subject: params.subject,
        html: params.html,
      });
      this.logger.log(`Email envoyé — organisation ${organizationId}, destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (hôte, identifiants) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi d'email pour l'organisation ${organizationId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException(
        "L'envoi de l'email a échoué. Vérifiez la configuration SMTP de l'organisation.",
      );
    }
  }

  /**
   * Envoie un récapitulatif de devis par email au destinataire fourni (S28).
   * Même patron que sendSaleSummary — cf. sa JSDoc pour la gestion du mode test et des erreurs.
   *
   * @param organizationId - Organisation dont la configuration SMTP est utilisée.
   * @param params - Destinataire, sujet et corps HTML déjà rendus (cf. quotation-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais de secret journalisé).
   * @throws BadRequestException si, hors mode test, aucune configuration SMTP n'existe pour
   *         l'organisation, ou si l'envoi via le serveur SMTP échoue.
   */
  async sendQuotationSummary(organizationId: string, params: SendEmailParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi d'email simulé (mode test) — destinataire=${params.to}, sujet="${params.subject}"`,
      );
      return;
    }

    const smtpConfig = await this.smtpServerService.findForOrg(organizationId);
    if (!smtpConfig) {
      throw new BadRequestException(
        "Aucun serveur SMTP n'est configuré pour cette organisation. " +
          'Configurez-en un avant d\'envoyer un email.',
      );
    }

    // Mot de passe déchiffré à la volée, jamais journalisé ni conservé au-delà de cet appel.
    const password = await this.smtpServerService.getDecryptedPassword(organizationId);

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.username,
        pass: password,
      },
    });

    try {
      await transporter.sendMail({
        from: `${smtpConfig.fromName} <${smtpConfig.fromEmail}>`,
        to: params.to,
        subject: params.subject,
        html: params.html,
      });
      this.logger.log(`Email envoyé — organisation ${organizationId}, destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (hôte, identifiants) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi d'email pour l'organisation ${organizationId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException(
        "L'envoi de l'email a échoué. Vérifiez la configuration SMTP de l'organisation.",
      );
    }
  }
}
