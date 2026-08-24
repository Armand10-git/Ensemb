import { escapeHtml } from '../messaging/message-format.util';

/** Couleur de repli — brand-500 de tailwind.config.ts (thème plateforme par défaut, docs/ux/tokens.md). */
const DEFAULT_PRIMARY_COLOR = '#2FA75E';

/** Format HEX 6 chiffres attendu (mirror de UpdateBrandingSchema, apps/api/src/modules/organizations/dto/update-branding.dto.ts). */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Sous-ensemble d'Organization nécessaire à l'habillage brandé d'un PDF (S34) — mirror
 * d'OrganizationBranding (messaging/branded-email.template.ts), avec `name` en plus (affiché
 * dans l'en-tête du document imprimé, absent de l'habillage email).
 */
export interface PdfOrganizationBranding {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

/**
 * Enveloppe un contenu HTML déjà rendu (vente/achat/devis/retour) dans un document PDF A4
 * brandé complet : en-tête logo + couleur + nom de l'organisation, styles d'impression, pied
 * de page répété sur chaque page. Contrainte différente d'un email (docs/roadmap/01-
 * architecture.md ligne 699) : mise en page A4, pagination, CSS d'impression — ne partage donc
 * que la logique de résolution de branding avec wrapBrandedEmail (messaging/), pas le HTML/CSS.
 *
 * `position: fixed` sur `.footer` : comportement standard du moteur d'impression de Chromium
 * (utilisé par Puppeteer) — un élément en position fixe est répété sur chaque page générée,
 * contrairement au flux normal du document. Pas besoin de l'API headerTemplate/footerTemplate
 * de `page.pdf()` (contexte isolé, plus difficile à thémer avec la couleur de l'organisation).
 *
 * @param title - titre du document (ex. "Facture VTE-2026-000001"), affiché dans l'en-tête et le <title>
 * @param contentHtml - corps déjà rendu par un renderer spécifique au document (jamais réécrit ici)
 * @param branding - name/logoUrl/primaryColor de l'organisation (Organization, T05)
 * @returns un document HTML autonome complet (avec <!doctype>), prêt pour PdfService.render()
 */
export function wrapBrandedPdf(
  title: string,
  contentHtml: string,
  branding: PdfOrganizationBranding,
): string {
  const primaryColor = HEX_COLOR_RE.test(branding.primaryColor ?? '')
    ? (branding.primaryColor as string)
    : DEFAULT_PRIMARY_COLOR;

  const logoHtml = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="Logo" style="max-height:52px;max-width:200px;display:block" />`
    : '';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1f2937; margin: 0; font-size: 12px; }
  .header { display:flex; justify-content:space-between; align-items:center; background-color:${primaryColor}; color:#ffffff; padding:16px 22px; }
  .header .brand { display:flex; align-items:center; gap:12px; }
  .header .org-name { font-size:16px; font-weight:bold; }
  .header .doc-title { font-size:14px; font-weight:600; text-align:right; }
  .content { padding: 22px 22px 60px 22px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th, td { padding:6px 8px; border-bottom:1px solid #e5e7eb; text-align:left; }
  th { background-color:#f9fafb; font-size:10.5px; text-transform:uppercase; color:#6b7280; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
  .totals { margin-top:16px; width:280px; margin-left:auto; }
  .totals td { border:none; padding:3px 0; }
  .totals .grand-total td { font-weight:bold; font-size:14px; border-top:2px solid #1f2937; padding-top:6px; }
  .footer { position:fixed; bottom:0; left:0; right:0; padding:10px 22px; font-size:10px; color:#9ca3af; text-align:center; border-top:1px solid #e5e7eb; background:#ffffff; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">
      ${logoHtml}
      <div class="org-name">${escapeHtml(branding.name)}</div>
    </div>
    <div class="doc-title">${escapeHtml(title)}</div>
  </div>
  <div class="content">${contentHtml}</div>
  <div class="footer">Document généré automatiquement par Ensemb.</div>
</body>
</html>`;
}
