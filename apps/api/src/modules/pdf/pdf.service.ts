import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import puppeteer, { type HTTPRequest } from 'puppeteer';

/**
 * Génération de PDF via Puppeteer headless (S34, §17 point Z).
 * N'existe que côté worker (jamais injecté dans un contrôleur HTTP) — Puppeteer est trop
 * coûteux en CPU/mémoire pour cohabiter avec le cycle requête/réponse du process API
 * (docs/roadmap/01-architecture.md §7).
 */
@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  /**
   * Rend un document HTML autonome en PDF A4.
   *
   * `executablePath` : en Docker/Alpine, le Chromium bundlé par défaut de puppeteer ne
   * fonctionne pas sur musl sans dépendances système supplémentaires — le Dockerfile installe
   * un Chromium système (`apk add chromium`) et fixe PUPPETEER_EXECUTABLE_PATH ; en local/CI
   * hors Docker, cette variable est absente et puppeteer utilise son Chromium téléchargé
   * (`onlyBuiltDependencies` dans le package.json racine).
   * `--no-sandbox` : requis pour exécuter Chromium sous l'utilisateur non-root du conteneur
   * (image `nestjs`, cf. Dockerfile) sans capacités Linux additionnelles.
   * `waitUntil: 'networkidle0'` : le logo de l'organisation (branding) est chargé depuis une
   * URL externe (Organization.logoUrl) — attendre la fin des requêtes réseau évite un PDF
   * avec une image cassée.
   *
   * Interception réseau (§17 « SSRF ») : `Organization.logoUrl` est une URL absolue saisie
   * librement par l'admin du tenant (update-branding.dto.ts, upload réel reporté à S13) —
   * sans filtrage, ce process serveur (via Puppeteer) requêterait n'importe quelle URL fournie
   * par un tenant lors du rendu, y compris des adresses internes (localhost, réseau privé,
   * endpoints de métadonnées cloud type 169.254.169.254). `isRequestAllowed` bloque tout ce qui
   * n'est pas http(s) vers une adresse publique avant que la requête ne parte.
   *
   * Le navigateur est fermé dans un `finally` : une instance Chromium orpheline en cas
   * d'erreur de rendu consommerait indéfiniment de la mémoire dans le process worker.
   *
   * @param html - document HTML autonome déjà rendu (cf. wrapBrandedPdf)
   * @returns le contenu binaire du PDF généré
   */
  async render(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void this.guardRequest(req);
      });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', bottom: '16mm', left: '14mm', right: '14mm' },
      });
      return Buffer.from(pdf);
    } catch (err) {
      this.logger.error('Échec du rendu PDF Puppeteer', err);
      throw err;
    } finally {
      await browser.close();
    }
  }

  /**
   * Laisse passer une requête réseau émise pendant le rendu uniquement si elle cible une
   * adresse publique en http(s) — bloque sinon (défense SSRF, §17). La première requête
   * (navigation `about:blank` déclenchée par `setContent`) a `req.url() === 'about:blank'` et
   * n'est jamais bloquante ; elle est laissée passer explicitement avant toute résolution DNS.
   */
  private async guardRequest(req: HTTPRequest): Promise<void> {
    const url = req.url();
    if (url === 'about:blank' || url.startsWith('data:')) {
      await req.continue();
      return;
    }

    if (await this.isSafePublicUrl(url)) {
      await req.continue();
      return;
    }

    this.logger.warn(`Requête bloquée pendant le rendu PDF (cible non publique) : ${url}`);
    await req.abort('blockedbyclient');
  }

  /**
   * Vrai si `rawUrl` est en http/https et que son hôte résout vers une adresse IP publique —
   * jamais loopback, privée (RFC 1918), link-local (inclut les endpoints de métadonnées cloud
   * 169.254.0.0/16, ex. AWS 169.254.169.254), ULA IPv6 ou toute plage réservée équivalente.
   * Résolution DNS explicite (plutôt qu'une simple regex sur le nom d'hôte) pour ne pas être
   * contourné par un domaine public dont l'enregistrement DNS pointe vers une IP interne
   * (DNS rebinding).
   */
  private async isSafePublicUrl(rawUrl: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    try {
      const host = parsed.hostname;
      const literalIp = isIP(host) ? host : null;
      const { address } = literalIp
        ? { address: literalIp }
        : await lookup(host);
      return !this.isPrivateOrReservedIp(address);
    } catch {
      // Résolution DNS impossible (hôte inexistant, timeout) — refusé par défaut.
      return false;
    }
  }

  /** Plages IPv4/IPv6 privées, loopback, link-local (incl. métadonnées cloud) et réservées. */
  private isPrivateOrReservedIp(address: string): boolean {
    if (isIP(address) === 4) {
      const [a = 0, b = 0] = address.split('.').map(Number);
      return (
        a === 127 || // loopback
        a === 10 || // RFC 1918
        (a === 172 && b >= 16 && b <= 31) || // RFC 1918
        (a === 192 && b === 168) || // RFC 1918
        (a === 169 && b === 254) || // link-local, y compris métadonnées cloud
        a === 0 ||
        a >= 224 // multicast/réservé
      );
    }
    const lower = address.toLowerCase();
    return (
      lower === '::1' || // loopback
      lower.startsWith('fe80:') || // link-local
      lower.startsWith('fc') ||
      lower.startsWith('fd') || // ULA
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:169.254.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }
}
