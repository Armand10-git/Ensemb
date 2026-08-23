import { escapeHtml } from './message-format.util';

/** Couleur de repli — brand-500 de tailwind.config.ts (thème plateforme par défaut, docs/ux/tokens.md). */
const DEFAULT_PRIMARY_COLOR = '#2FA75E';

/** Format HEX 6 chiffres attendu (mirror de UpdateBrandingSchema, apps/api/src/modules/organizations/dto/update-branding.dto.ts). */
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Sous-ensemble d'Organization nécessaire à l'habillage brandé d'un email (T05) —
 * délibérément pas Organization complet, cf. patron SaleMessageInput.
 */
export interface OrganizationBranding {
  logoUrl: string | null;
  primaryColor: string | null;
}

/**
 * Enveloppe un contenu HTML déjà rendu (sale/quotation/purchase/payment-receipt/return) dans
 * l'habillage brandé commun : en-tête logo + couleur de l'organisation, pied de page. Couche
 * d'habillage autour des renderers existants — ne remplace pas leur rendu, l'entoure.
 *
 * Repli sur le thème par défaut de la plateforme (couleur brand verte, tailwind.config.ts) si
 * `primaryColor` est absent ou ne respecte pas le format HEX 6 chiffres déjà imposé à l'écriture
 * par UpdateBrandingSchema (défensif — ne fait jamais échouer le rendu sur une donnée invalide).
 * Aucun logo affiché si `logoUrl` est absent, plutôt qu'une image cassée.
 *
 * @param contentHtml - Corps déjà rendu par un renderer spécifique au document (jamais réécrit ici).
 * @param branding - logoUrl/primaryColor de l'organisation (Organization.logoUrl/primaryColor, T05).
 * @returns Une chaîne HTML autonome, prête à être passée à EmailService.
 */
export function wrapBrandedEmail(contentHtml: string, branding: OrganizationBranding): string {
  const primaryColor = HEX_COLOR_RE.test(branding.primaryColor ?? '')
    ? (branding.primaryColor as string)
    : DEFAULT_PRIMARY_COLOR;

  const logoHtml = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="Logo" style="max-height:48px;max-width:200px" />`
    : '';

  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937">
      <div style="background-color:${primaryColor};padding:16px;text-align:center;border-radius:4px 4px 0 0">
        ${logoHtml}
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none">
        ${contentHtml}
      </div>
      <div style="padding:16px;text-align:center;color:#9ca3af;font-size:12px">
        Cet email a été généré automatiquement par Ensemb.
      </div>
    </div>`;
}
