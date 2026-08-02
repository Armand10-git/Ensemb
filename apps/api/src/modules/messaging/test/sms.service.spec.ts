import { BadRequestException } from '@nestjs/common';
import twilio from 'twilio';
import { SmsService } from '../sms.service';

jest.mock('twilio');

const makeConfig = (overrides: Record<string, string | undefined>) => ({
  get: jest.fn((key: string) => overrides[key]),
});

describe('SmsService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('mode test (NODE_ENV=test) : aucun appel Twilio', async () => {
    const service = new SmsService(makeConfig({ NODE_ENV: 'test' }) as never);

    await service.sendSaleSummary('org-1', {
      to: '+237600000000',
      body: 'Vente V-001 — Total : 5 000 XAF — Statut : Payée.',
    });

    expect(twilio).not.toHaveBeenCalled();
  });

  it("hors mode test, identifiants Twilio absents : lève une BadRequestException, sans appel réseau", async () => {
    const service = new SmsService(makeConfig({ NODE_ENV: 'production' }) as never);

    await expect(
      service.sendSaleSummary('org-1', { to: '+237600000000', body: 'x' }),
    ).rejects.toThrow(BadRequestException);
    expect(twilio).not.toHaveBeenCalled();
  });

  it('hors mode test, identifiants Twilio présents : envoie via Twilio', async () => {
    const create = jest.fn().mockResolvedValue({ sid: 'SM123' });
    (twilio as unknown as jest.Mock).mockReturnValue({ messages: { create } });

    const service = new SmsService(
      makeConfig({
        NODE_ENV: 'production',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token123',
        TWILIO_FROM_NUMBER: '+237699999999',
      }) as never,
    );

    await service.sendSaleSummary('org-1', { to: '+237600000000', body: 'Vente V-001' });

    expect(twilio).toHaveBeenCalledWith('AC123', 'token123');
    expect(create).toHaveBeenCalledWith({
      to: '+237600000000',
      from: '+237699999999',
      body: 'Vente V-001',
    });
  });

  it("propage une erreur claire (BadRequestException) si l'envoi Twilio échoue", async () => {
    const create = jest.fn().mockRejectedValue(new Error('boom'));
    (twilio as unknown as jest.Mock).mockReturnValue({ messages: { create } });

    const service = new SmsService(
      makeConfig({
        NODE_ENV: 'production',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token123',
        TWILIO_FROM_NUMBER: '+237699999999',
      }) as never,
    );

    await expect(
      service.sendSaleSummary('org-1', { to: '+237600000000', body: 'x' }),
    ).rejects.toThrow(BadRequestException);
  });
});
