import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';

/** Paramètres d'envoi d'un SMS — le corps est déjà rendu par l'appelant. */
export interface SendSmsParams {
  to: string;
  body: string;
}

/**
 * Envoi de SMS transactionnels (récapitulatif de vente, S24) via Twilio.
 *
 * Contrairement à la configuration SMTP (par organisation), les identifiants Twilio
 * sont des identifiants PLATEFORME, lus une seule fois depuis ConfigService
 * (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) — décision actée S24,
 * aucun modèle SmsServer par tenant.
 *
 * Mode test — aucun envoi réel : NODE_ENV=test uniquement (comme EmailService, cf.
 * sa JSDoc pour le raisonnement). Si NODE_ENV n'est pas 'test' mais que les
 * identifiants Twilio sont absents de la configuration plateforme, sendSaleSummary
 * lève une erreur explicite plutôt que d'échouer silencieusement — un identifiant
 * Twilio manquant en production est une erreur de configuration serveur, pas un cas
 * normal.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly isTestMode: boolean;
  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;
  private readonly fromNumber: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.config.get<string>('TWILIO_FROM_NUMBER');

    this.isTestMode = this.config.get<string>('NODE_ENV') === 'test';

    if (this.isTestMode) {
      this.logger.log('SmsService en mode test — aucun envoi SMS réel');
    }
  }

  /**
   * Envoie un récapitulatif de vente par SMS au destinataire fourni.
   *
   * @param _organizationId - Non utilisé pour la configuration (identifiants plateforme),
   *        conservé pour la cohérence de signature avec EmailService et pour un futur
   *        usage (quotas par organisation, traçabilité). Préfixé `_` (inutilisé, cf.
   *        règle eslint no-unused-vars/argsIgnorePattern).
   * @param params - Destinataire et corps du message déjà rendu (cf. sale-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais le contenu complet
   *          ni les identifiants Twilio).
   * @throws BadRequestException si, hors mode test, les identifiants Twilio sont absents
   *         de la configuration plateforme, ou si l'envoi échoue.
   */
  async sendSaleSummary(_organizationId: string, params: SendSmsParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi de SMS simulé (mode test) — destinataire=${params.to}, longueur=${params.body.length}`,
      );
      return;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new BadRequestException(
        "L'envoi de SMS n'est pas configuré sur cette plateforme (identifiants Twilio manquants).",
      );
    }

    const client = twilio(this.accountSid, this.authToken);

    try {
      await client.messages.create({
        to: params.to,
        from: this.fromNumber,
        body: params.body,
      });
      this.logger.log(`SMS envoyé — destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (identifiants Twilio) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi de SMS vers ${params.to}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("L'envoi du SMS a échoué. Veuillez réessayer plus tard.");
    }
  }

  /**
   * Envoie un récapitulatif de devis par SMS au destinataire fourni (S28).
   * Même patron que sendSaleSummary — cf. sa JSDoc pour la gestion du mode test et des erreurs.
   *
   * @param _organizationId - Non utilisé pour la configuration (identifiants plateforme),
   *        conservé pour la cohérence de signature avec EmailService et pour un futur
   *        usage (quotas par organisation, traçabilité). Préfixé `_` (inutilisé, cf.
   *        règle eslint no-unused-vars/argsIgnorePattern).
   * @param params - Destinataire et corps du message déjà rendu (cf. quotation-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais le contenu complet
   *          ni les identifiants Twilio).
   * @throws BadRequestException si, hors mode test, les identifiants Twilio sont absents
   *         de la configuration plateforme, ou si l'envoi échoue.
   */
  async sendQuotationSummary(_organizationId: string, params: SendSmsParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi de SMS simulé (mode test) — destinataire=${params.to}, longueur=${params.body.length}`,
      );
      return;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new BadRequestException(
        "L'envoi de SMS n'est pas configuré sur cette plateforme (identifiants Twilio manquants).",
      );
    }

    const client = twilio(this.accountSid, this.authToken);

    try {
      await client.messages.create({
        to: params.to,
        from: this.fromNumber,
        body: params.body,
      });
      this.logger.log(`SMS envoyé — destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (identifiants Twilio) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi de SMS vers ${params.to}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("L'envoi du SMS a échoué. Veuillez réessayer plus tard.");
    }
  }

  /**
   * Envoie un récapitulatif d'achat par SMS au destinataire fourni (S33).
   * Même patron que sendSaleSummary — cf. sa JSDoc pour la gestion du mode test et des erreurs.
   *
   * @param _organizationId - Non utilisé pour la configuration (identifiants plateforme),
   *        conservé pour la cohérence de signature avec EmailService et pour un futur
   *        usage (quotas par organisation, traçabilité). Préfixé `_` (inutilisé, cf.
   *        règle eslint no-unused-vars/argsIgnorePattern).
   * @param params - Destinataire et corps du message déjà rendu (cf. purchase-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais le contenu complet
   *          ni les identifiants Twilio).
   * @throws BadRequestException si, hors mode test, les identifiants Twilio sont absents
   *         de la configuration plateforme, ou si l'envoi échoue.
   */
  async sendPurchaseSummary(_organizationId: string, params: SendSmsParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi de SMS simulé (mode test) — destinataire=${params.to}, longueur=${params.body.length}`,
      );
      return;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new BadRequestException(
        "L'envoi de SMS n'est pas configuré sur cette plateforme (identifiants Twilio manquants).",
      );
    }

    const client = twilio(this.accountSid, this.authToken);

    try {
      await client.messages.create({
        to: params.to,
        from: this.fromNumber,
        body: params.body,
      });
      this.logger.log(`SMS envoyé — destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (identifiants Twilio) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi de SMS vers ${params.to}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("L'envoi du SMS a échoué. Veuillez réessayer plus tard.");
    }
  }

  /**
   * Envoie un reçu de paiement par SMS au destinataire fourni (S33).
   * Même patron que sendSaleSummary — cf. sa JSDoc pour la gestion du mode test et des erreurs.
   *
   * @param _organizationId - Non utilisé pour la configuration (identifiants plateforme),
   *        conservé pour la cohérence de signature avec EmailService et pour un futur
   *        usage (quotas par organisation, traçabilité). Préfixé `_` (inutilisé, cf.
   *        règle eslint no-unused-vars/argsIgnorePattern).
   * @param params - Destinataire et corps du message déjà rendu (cf. payment-receipt-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais le contenu complet
   *          ni les identifiants Twilio).
   * @throws BadRequestException si, hors mode test, les identifiants Twilio sont absents
   *         de la configuration plateforme, ou si l'envoi échoue.
   */
  async sendPaymentReceipt(_organizationId: string, params: SendSmsParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi de SMS simulé (mode test) — destinataire=${params.to}, longueur=${params.body.length}`,
      );
      return;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new BadRequestException(
        "L'envoi de SMS n'est pas configuré sur cette plateforme (identifiants Twilio manquants).",
      );
    }

    const client = twilio(this.accountSid, this.authToken);

    try {
      await client.messages.create({
        to: params.to,
        from: this.fromNumber,
        body: params.body,
      });
      this.logger.log(`SMS envoyé — destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (identifiants Twilio) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi de SMS vers ${params.to}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("L'envoi du SMS a échoué. Veuillez réessayer plus tard.");
    }
  }

  /**
   * Envoie un récapitulatif de retour par SMS au destinataire fourni (S33).
   * Même patron que sendSaleSummary — cf. sa JSDoc pour la gestion du mode test et des erreurs.
   *
   * @param _organizationId - Non utilisé pour la configuration (identifiants plateforme),
   *        conservé pour la cohérence de signature avec EmailService et pour un futur
   *        usage (quotas par organisation, traçabilité). Préfixé `_` (inutilisé, cf.
   *        règle eslint no-unused-vars/argsIgnorePattern).
   * @param params - Destinataire et corps du message déjà rendu (cf. return-message.renderer.ts).
   * @returns Rien — en mode test, l'envoi est simulé par un log (jamais le contenu complet
   *          ni les identifiants Twilio).
   * @throws BadRequestException si, hors mode test, les identifiants Twilio sont absents
   *         de la configuration plateforme, ou si l'envoi échoue.
   */
  async sendReturnSummary(_organizationId: string, params: SendSmsParams): Promise<void> {
    if (this.isTestMode) {
      this.logger.log(
        `Envoi de SMS simulé (mode test) — destinataire=${params.to}, longueur=${params.body.length}`,
      );
      return;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new BadRequestException(
        "L'envoi de SMS n'est pas configuré sur cette plateforme (identifiants Twilio manquants).",
      );
    }

    const client = twilio(this.accountSid, this.authToken);

    try {
      await client.messages.create({
        to: params.to,
        from: this.fromNumber,
        body: params.body,
      });
      this.logger.log(`SMS envoyé — destinataire=${params.to}`);
    } catch (err) {
      // Aucun détail interne (identifiants Twilio) exposé au client — message générique,
      // détail journalisé côté serveur uniquement (§17 point « Fuites »).
      this.logger.error(
        `Échec de l'envoi de SMS vers ${params.to}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new BadRequestException("L'envoi du SMS a échoué. Veuillez réessayer plus tard.");
    }
  }
}
