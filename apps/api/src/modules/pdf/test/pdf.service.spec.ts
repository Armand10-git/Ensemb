import puppeteer from 'puppeteer';
import { PdfService } from '../pdf.service';

describe('PdfService', () => {
  let service: PdfService;

  beforeEach(() => {
    service = new PdfService();
  });

  it('produit un buffer PDF valide (en-tête %PDF-)', async () => {
    const buffer = await service.render('<html><body><h1>Test</h1></body></html>');

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 60000);

  it('ferme le navigateur même si le rendu échoue (pas de fuite de process Chromium)', async () => {
    const fakeBrowser = {
      newPage: jest.fn().mockRejectedValue(new Error('échec de rendu simulé')),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const launchSpy = jest
      .spyOn(puppeteer, 'launch')
      // Le typage réel de puppeteer.launch() est trop strict pour un double de test minimal —
      // seuls newPage()/close() sont exercés par PdfService.render().
      .mockResolvedValue(fakeBrowser as never);

    await expect(service.render('<html></html>')).rejects.toThrow('échec de rendu simulé');
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);

    launchSpy.mockRestore();
  });

  it('ferme le navigateur même si page.pdf() échoue', async () => {
    const fakePage = {
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockRejectedValue(new Error('échec pdf simulé')),
    };
    const fakeBrowser = {
      newPage: jest.fn().mockResolvedValue(fakePage),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const launchSpy = jest
      .spyOn(puppeteer, 'launch')
      .mockResolvedValue(fakeBrowser as never);

    await expect(service.render('<html></html>')).rejects.toThrow('échec pdf simulé');
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);

    launchSpy.mockRestore();
  });

  // §17 « SSRF » — Organization.logoUrl est une URL absolue saisie librement par l'admin du
  // tenant (update-branding.dto.ts) ; sans filtrage, Puppeteer la requêterait côté serveur
  // pendant le rendu. Ces deux tests vérifient que le rendu aboutit malgré une image ciblant
  // une adresse interne (requête bloquée, pas de blocage/plantage du rendu) — la preuve
  // positive que le blocage fonctionne serait un test d'intégration réseau, hors de portée
  // d'un test unitaire déterministe ; ici on vérifie l'absence d'effet de bord dangereux et de
  // hang, ce qui est déjà le comportement attendu de req.abort().
  it("n'échoue pas et ne reste pas bloqué si le HTML référence une adresse loopback (127.0.0.1)", async () => {
    const buffer = await service.render(
      '<html><body><img src="http://127.0.0.1:9/x.png" /></body></html>',
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 60000);

  it("n'échoue pas et ne reste pas bloqué si le HTML référence l'endpoint de métadonnées cloud (169.254.169.254)", async () => {
    const buffer = await service.render(
      '<html><body><img src="http://169.254.169.254/latest/meta-data/" /></body></html>',
    );

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  }, 60000);
});
