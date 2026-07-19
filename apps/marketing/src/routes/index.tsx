import React from 'react';
import { HeroSection } from '../components/HeroSection';
import { FindOrgForm } from '../components/FindOrgForm';

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
      <div className="mb-3 text-3xl" aria-hidden="true">
        {icon}
      </div>
      <h3 className="mb-2 text-base font-semibold text-gray-900">{title}</h3>
      <p className="text-sm leading-relaxed text-gray-600">{description}</p>
    </div>
  );
}

const FEATURES = [
  {
    icon: '🛒',
    title: 'Caisse',
    description: 'Point de vente rapide avec prise en charge du Mobile Money, des espèces et des paiements mixtes.',
  },
  {
    icon: '📦',
    title: 'Stock',
    description: 'Suivi en temps réel par dépôt, alertes de rupture et historique des mouvements.',
  },
  {
    icon: '🧾',
    title: 'Facturation',
    description: 'Factures PDF en XAF, devis, bons de commande — tous numérotés automatiquement.',
  },
  {
    icon: '👥',
    title: 'Multi-utilisateurs',
    description: 'Rôles et permissions granulaires pour gérer caissiers, gérants et administrateurs.',
  },
];

/** Page d'accueil du site marketing — parcours §18.17. */
export function HomePage(): React.ReactElement {
  return (
    <>
      <HeroSection />

      {/* Section fonctionnalités */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-10 text-center text-2xl font-bold text-gray-900">
            Tout ce dont votre commerce a besoin
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      {/* Section "Déjà client ?" */}
      <section id="trouver-organisation" className="py-16">
        <div className="mx-auto max-w-md px-4 text-center">
          <h2 className="mb-2 text-2xl font-bold text-gray-900">Déjà client ?</h2>
          <p className="mb-6 text-gray-600">
            Saisissez l'identifiant de votre organisation pour accéder à votre espace.
          </p>
          <FindOrgForm />
        </div>
      </section>
    </>
  );
}
