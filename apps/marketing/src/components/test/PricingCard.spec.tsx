import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PricingCard, formatXAF } from '../PricingCard';
import { PricingPage } from '../../routes/pricing';

const BASE_PROPS = {
  name: 'Starter',
  monthlyPrice: 5_000,
  features: [
    { label: 'utilisateurs', value: 3 },
    { label: 'depots', value: null },
  ],
  ctaUrl: 'https://app.monapp.com/signup',
};

// --- tests unitaires du formatage ---

describe('formatXAF', () => {
  it('contient le montant et la devise', () => {
    const result = formatXAF(5_000);
    // Intl peut produire "5 000 FCFA", "5 000 XAF" ou "XAF 5 000" selon l'environnement.
    // \s couvre l'espace insecable (U+202F) utilise par la locale fr-CM.
    expect(result).toMatch(/5[\s,.]?000/);
    expect(result.toUpperCase()).toMatch(/XAF|FCFA/);
  });
});

// --- tests composant ---

describe('PricingCard', () => {
  it('affiche le prix mensuel correctement en XAF', () => {
    render(<PricingCard {...BASE_PROPS} billingCycle="monthly" />);
    const priceEl = screen.getByTestId('plan-price');
    expect(priceEl.textContent).toMatch(/5[\s,.]?000/);
    expect(priceEl.textContent?.toUpperCase()).toMatch(/XAF|FCFA/);
  });

  it('affiche le prix annuel (pas le mensuel) quand annual est selectionne', () => {
    render(<PricingCard {...BASE_PROPS} billingCycle="annual" />);
    const priceEl = screen.getByTestId('plan-price');
    // Prix annuel = 5000 x 10 = 50 000
    expect(priceEl.textContent).toMatch(/50[\s,.]?000/);
    // Ne doit pas afficher "5 000" seul (sans le 0 supplementaire)
    expect(priceEl.textContent).not.toMatch(/^5[\s,.]?000[^0]/);
  });

  it('affiche "illimite" pour un quota null', () => {
    render(<PricingCard {...BASE_PROPS} billingCycle="monthly" />);
    expect(screen.getByText(/Illimit/i)).toBeInTheDocument();
  });

  it('affiche la valeur numerique quand le quota est defini', () => {
    render(<PricingCard {...BASE_PROPS} billingCycle="monthly" />);
    expect(screen.getByText(/3 utilisateurs/i)).toBeInTheDocument();
  });

  it('affiche le nom du plan', () => {
    render(<PricingCard {...BASE_PROPS} billingCycle="monthly" />);
    expect(screen.getByRole('heading', { name: 'Starter' })).toBeInTheDocument();
  });
});

// --- test du toggle sur la page tarifs ---

describe('PricingPage — toggle mensuel/annuel', () => {
  const user = userEvent.setup();

  it('affiche les prix mensuels par defaut', () => {
    render(<PricingPage />);
    const prices = screen.getAllByTestId('plan-price');
    // Starter: 5 000, Pro: 15 000, Enterprise: 40 000
    expect(prices[0]?.textContent).toMatch(/5[\s,.]?000/);
    expect(prices[1]?.textContent).toMatch(/15[\s,.]?000/);
  });

  it('passe aux prix annuels apres clic sur "Annuel"', async () => {
    render(<PricingPage />);
    await user.click(screen.getByRole('button', { name: /Annuel/i }));
    const prices = screen.getAllByTestId('plan-price');
    // Starter annuel: 50 000, Pro annuel: 150 000
    expect(prices[0]?.textContent).toMatch(/50[\s,.]?000/);
    expect(prices[1]?.textContent).toMatch(/150[\s,.]?000/);
  });

  it('revient aux prix mensuels apres clic sur "Mensuel"', async () => {
    render(<PricingPage />);
    await user.click(screen.getByRole('button', { name: /Annuel/i }));
    await user.click(screen.getByRole('button', { name: /Mensuel/i }));
    const prices = screen.getAllByTestId('plan-price');
    expect(prices[0]?.textContent).toMatch(/5[\s,.]?000/);
  });
});
