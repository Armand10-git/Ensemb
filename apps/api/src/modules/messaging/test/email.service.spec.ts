import { BadRequestException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { EmailService } from '../email.service';

jest.mock('nodemailer');

const makeConfig = (nodeEnv: string | undefined) => ({
  get: jest.fn((key: string) => (key === 'NODE_ENV' ? nodeEnv : undefined)),
});

describe('EmailService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('mode test (NODE_ENV=test)', () => {
    it("n'effectue aucun appel réseau ni aucune lecture de configuration SMTP", async () => {
      const smtpServerService = { findForOrg: jest.fn(), getDecryptedPassword: jest.fn() };
      const service = new EmailService(makeConfig('test') as never, smtpServerService as never);

      await service.sendSaleSummary('org-1', {
        to: 'client@example.com',
        subject: 'Vente V-001',
        html: '<p>ok</p>',
      });

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(smtpServerService.findForOrg).not.toHaveBeenCalled();
    });
  });

  describe('hors mode test', () => {
    it("lève une BadRequestException si aucune configuration SMTP n'existe pour l'organisation", async () => {
      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue(null),
        getDecryptedPassword: jest.fn(),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await expect(
        service.sendSaleSummary('org-1', {
          to: 'client@example.com',
          subject: 'Vente V-001',
          html: '<p>ok</p>',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('construit un transporteur Nodemailer et envoie via sendMail quand la config existe', async () => {
      const sendMail = jest.fn().mockResolvedValue(undefined);
      (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue({
          host: 'smtp.example.com',
          port: 587,
          username: 'user@example.com',
          fromEmail: 'noreply@example.com',
          fromName: 'Ensemb',
        }),
        getDecryptedPassword: jest.fn().mockResolvedValue('mot-de-passe-secret'),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await service.sendSaleSummary('org-1', {
        to: 'client@example.com',
        subject: 'Vente V-001',
        html: '<p>ok</p>',
      });

      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          auth: { user: 'user@example.com', pass: 'mot-de-passe-secret' },
        }),
      );
      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Ensemb <noreply@example.com>',
          to: 'client@example.com',
          subject: 'Vente V-001',
          html: '<p>ok</p>',
        }),
      );
    });

    it("lève une BadRequestException générique si l'envoi échoue, sans exposer le détail interne", async () => {
      const sendMail = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue({
          host: 'smtp.example.com',
          port: 587,
          username: 'user@example.com',
          fromEmail: 'noreply@example.com',
          fromName: 'Ensemb',
        }),
        getDecryptedPassword: jest.fn().mockResolvedValue('mot-de-passe-secret'),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await expect(
        service.sendSaleSummary('org-1', {
          to: 'client@example.com',
          subject: 'Vente V-001',
          html: '<p>ok</p>',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('sendQuotationSummary', () => {
    it("mode test (NODE_ENV=test) : n'effectue aucun appel réseau ni aucune lecture de configuration SMTP", async () => {
      const smtpServerService = { findForOrg: jest.fn(), getDecryptedPassword: jest.fn() };
      const service = new EmailService(makeConfig('test') as never, smtpServerService as never);

      await service.sendQuotationSummary('org-1', {
        to: 'client@example.com',
        subject: 'Devis DEV-001',
        html: '<p>ok</p>',
      });

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(smtpServerService.findForOrg).not.toHaveBeenCalled();
    });

    it("hors mode test, lève une BadRequestException si aucune configuration SMTP n'existe pour l'organisation", async () => {
      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue(null),
        getDecryptedPassword: jest.fn(),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await expect(
        service.sendQuotationSummary('org-1', {
          to: 'client@example.com',
          subject: 'Devis DEV-001',
          html: '<p>ok</p>',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('hors mode test, construit un transporteur Nodemailer et envoie via sendMail quand la config existe', async () => {
      const sendMail = jest.fn().mockResolvedValue(undefined);
      (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue({
          host: 'smtp.example.com',
          port: 587,
          username: 'user@example.com',
          fromEmail: 'noreply@example.com',
          fromName: 'Ensemb',
        }),
        getDecryptedPassword: jest.fn().mockResolvedValue('mot-de-passe-secret'),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await service.sendQuotationSummary('org-1', {
        to: 'client@example.com',
        subject: 'Devis DEV-001',
        html: '<p>ok</p>',
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Ensemb <noreply@example.com>',
          to: 'client@example.com',
          subject: 'Devis DEV-001',
          html: '<p>ok</p>',
        }),
      );
    });

    it("lève une BadRequestException générique si l'envoi échoue, sans exposer le détail interne", async () => {
      const sendMail = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

      const smtpServerService = {
        findForOrg: jest.fn().mockResolvedValue({
          host: 'smtp.example.com',
          port: 587,
          username: 'user@example.com',
          fromEmail: 'noreply@example.com',
          fromName: 'Ensemb',
        }),
        getDecryptedPassword: jest.fn().mockResolvedValue('mot-de-passe-secret'),
      };
      const service = new EmailService(
        makeConfig('production') as never,
        smtpServerService as never,
      );

      await expect(
        service.sendQuotationSummary('org-1', {
          to: 'client@example.com',
          subject: 'Devis DEV-001',
          html: '<p>ok</p>',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
