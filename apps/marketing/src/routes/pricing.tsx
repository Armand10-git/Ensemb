import React, { useState } from 'react';
import { PricingCard, type BillingCycle, type PlanFeature } from '../components/PricingCard';

interface Plan {
  name: string;
  monthlyPrice: number;
  features: PlanFeature[];
  highlighted?: boolean;
}

/** Plans issus des seeds T06. */
const PLANS: Plan[] = [
  {
    name: 'Starter',
    monthlyPrice: 5_000,
    features: [
      { label: 'utilisateurs', value: 3 },
      { label: 'dépôts', value: 1 },
      { label: 'produits', value: 500 },
    ],
  },
  {
    name: 'Pro',
    monthlyPrice: 15_000,
    highlighted: true,
    features: [
      { label: 'utilisateurs', value: 10 },
      { label: 'dépôts', value: 3 },
      { label: 'produits', value: 5_000 },
    ],
  },
  {
    name: 'Enterprise',
    monthlyPrice: 40_000,
    features: [
      { label: 'utilisateurs', value: null },
      { label: 'dépôts', value: null },
      { label: 'produits', value: null },
    ],
  },
];

/** Page tarifs avec toggle mensuel/annuel — parcours §18.17. */
export function PricingPage(): React.ReactElement {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const appUrl = import.meta.env.VITE_APP_URL as string;
  const ctaUrl = `${appUrl}/signup`;

  return (
    <section className="py-16">
      <div className="mx-auto max-w-5xl px-4">
        <div className="mb-10 text-center">
          <h1 className="mb-3 text-3xl font-bold text-gray-900">Des tarifs clairs et adaptés</h1>
          <p className="mb-6 text-gray-600">
            Démarrez gratuitement pendant 30 jours, sans carte bancaire.
          </p>

          {/* Toggle mensuel / annuel */}
          <div
            role="group"
            aria-label="Cycle de facturation"
            className="inline-flex items-center rounded-lg border border-gray-200 bg-gray-100 p-1"
          >
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              aria-pressed={billingCycle === 'monthly'}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                billingCycle === 'monthly'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Mensuel
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('annual')}
              aria-pressed={billingCycle === 'annual'}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                billingCycle === 'annual'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Annuel
              <span className="ml-1.5 rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-700">
                −2 mois
              </span>
            </button>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-3">
          {PLANS.map((plan) => (
            <PricingCard
              key={plan.name}
              name={plan.name}
              monthlyPrice={plan.monthlyPrice}
              features={plan.features}
              billingCycle={billingCycle}
              ctaUrl={ctaUrl}
              highlighted={plan.highlighted}
            />
          ))}
        </div>

        {/* Dette documentée T10 : pas de pré-sélection de plan au signup */}
        <p className="mt-8 text-center text-xs text-gray-400">
          Tous les prix sont en XAF (Franc CFA). TVA non applicable.
        </p>
      </div>
    </section>
  );
}
