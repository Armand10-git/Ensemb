import React from 'react';

/**
 * Section hero de la page d'accueil.
 * Le lien CTA pointe vers VITE_APP_URL/signup (apps/web — parcours §18.0).
 */
export function HeroSection(): React.ReactElement {
  const appUrl = import.meta.env.VITE_APP_URL as string;

  return (
    <section className="bg-gradient-to-br from-brand-900 via-brand-700 to-blue-500 py-20 text-white">
      <div className="mx-auto max-w-4xl px-4 text-center">
        <h1 className="mb-4 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
          L'ERP/POS pensé pour les commerçants camerounais
        </h1>
        <p className="mx-auto mb-8 max-w-2xl text-lg text-blue-100 sm:text-xl">
          Gérez votre caisse, votre stock et vos factures depuis un seul outil. Simple, rapide et
          adapté au marché local — en XAF, multi-dépôts, multi-utilisateurs.
        </p>
        <a
          href={`${appUrl}/signup`}
          className="inline-block rounded-lg bg-white px-8 py-3 text-base font-semibold text-brand-700 shadow-md hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-blue-600"
        >
          Essayer gratuitement
        </a>
        <p className="mt-4 text-sm text-blue-200">Aucune carte bancaire requise · Essai 30 jours</p>
      </div>
    </section>
  );
}
