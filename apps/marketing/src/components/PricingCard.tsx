import React from 'react';

export type BillingCycle = 'monthly' | 'annual';

export interface PlanFeature {
  label: string;
  /** null = illimité */
  value: number | null;
}

export interface PricingCardProps {
  name: string;
  /** Prix mensuel en XAF */
  monthlyPrice: number;
  features: PlanFeature[];
  billingCycle: BillingCycle;
  ctaUrl: string;
  highlighted?: boolean;
}

/** Remise annuelle : 2 mois offerts (prix × 10). */
const ANNUAL_MONTHS = 10;

/**
 * Formate un montant en XAF avec séparateur de milliers.
 * Utilise Intl.NumberFormat — jamais de formatage manuel.
 */
export function formatXAF(amount: number): string {
  return new Intl.NumberFormat('fr-CM', { style: 'currency', currency: 'XAF' }).format(amount);
}

/**
 * Carte de tarification affichant prix mensuel ou annuel selon billingCycle.
 * La remise annuelle est calculée en JS (2 mois offerts).
 */
export function PricingCard({
  name,
  monthlyPrice,
  features,
  billingCycle,
  ctaUrl,
  highlighted = false,
}: PricingCardProps): React.ReactElement {
  const annualTotal = monthlyPrice * ANNUAL_MONTHS;
  const displayPrice = billingCycle === 'monthly' ? monthlyPrice : annualTotal;
  const priceSuffix = billingCycle === 'monthly' ? '/mois' : '/an';

  return (
    <div
      className={`flex flex-col rounded-2xl border p-6 shadow-sm ${
        highlighted
          ? 'border-blue-500 bg-blue-600 text-white shadow-lg'
          : 'border-gray-200 bg-white text-gray-900'
      }`}
    >
      <h3
        className={`mb-1 text-lg font-semibold ${highlighted ? 'text-white' : 'text-gray-900'}`}
      >
        {name}
      </h3>

      {billingCycle === 'annual' && (
        <p className={`mb-1 text-xs ${highlighted ? 'text-blue-200' : 'text-gray-400'}`}>
          <span className="line-through">{formatXAF(monthlyPrice * 12)}/an</span>
          {' '}— 2 mois offerts
        </p>
      )}

      <div className="mb-4 mt-2">
        <span
          data-testid="plan-price"
          className={`text-3xl font-bold tabular-nums ${highlighted ? 'text-white' : 'text-gray-900'}`}
        >
          {formatXAF(displayPrice)}
        </span>
        <span className={`ml-1 text-sm ${highlighted ? 'text-blue-200' : 'text-gray-500'}`}>
          {priceSuffix}
        </span>
      </div>

      <ul className="mb-6 flex-1 space-y-2">
        {features.map((feature) => (
          <li key={feature.label} className="flex items-center gap-2 text-sm">
            <span className={highlighted ? 'text-blue-200' : 'text-blue-600'}>✓</span>
            <span className={highlighted ? 'text-blue-100' : 'text-gray-700'}>
              {feature.value === null ? 'Illimité' : feature.value}{' '}
              {feature.label}
            </span>
          </li>
        ))}
      </ul>

      <a
        href={ctaUrl}
        className={`block rounded-lg px-4 py-2 text-center text-sm font-semibold transition-colors ${
          highlighted
            ? 'bg-white text-blue-600 hover:bg-blue-50'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        Choisir ce plan
      </a>
    </div>
  );
}
