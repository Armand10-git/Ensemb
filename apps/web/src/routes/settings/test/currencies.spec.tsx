import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CurrenciesPage } from '../currencies';

// ─── Mock API ────────────────────────────────────────────────────────────────

vi.mock('../../../lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../../../lib/api';
const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const XAF = {
  id: 'cur-xaf',
  code: 'XAF',
  name: 'Franc CFA BEAC',
  symbol: 'XAF',
  symbolPosition: 'AFTER' as const,
  decimalPlaces: 0,
  isActive: true,
};

const EUR = {
  id: 'cur-eur',
  code: 'EUR',
  name: 'Euro',
  symbol: '€',
  symbolPosition: 'BEFORE' as const,
  decimalPlaces: 2,
  isActive: true,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CurrenciesPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CurrenciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletonDivs = document.querySelectorAll('.bg-gray-200.rounded');
    expect(skeletonDivs.length).toBeGreaterThan(0);
  });

  it('affiche la liste des devises avec code, nom et symbole', async () => {
    mockApi.get.mockResolvedValue([XAF, EUR]);
    renderPage();
    await waitFor(() => {
      // XAF apparaît dans la colonne Code ET Symbole → getAllByText
      expect(screen.getAllByText('XAF').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Franc CFA BEAC')).toBeInTheDocument();
      expect(screen.getByText('EUR')).toBeInTheDocument();
      expect(screen.getByText('Euro')).toBeInTheDocument();
    });
  });

  it('affiche l\'etat vide si aucune devise', async () => {
    mockApi.get.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/aucune devise/i)).toBeInTheDocument();
    });
  });

  it('affiche une banniere d\'erreur si le chargement echoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Serveur indisponible'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });

  it('appelle PATCH /organizations/default-currency a la sauvegarde', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/currencies') return Promise.resolve([XAF, EUR]);
      if (url === '/organizations/me') return Promise.resolve({ defaultCurrencyId: XAF.id });
      return Promise.resolve(null);
    });
    mockApi.patch.mockResolvedValue({ defaultCurrencyId: EUR.id });

    renderPage();

    // Attendre que les options soient chargées (select enabled + options présentes)
    await waitFor(() => {
      const select = screen.getByTestId('default-currency-select') as HTMLSelectElement;
      expect(select).not.toBeDisabled();
      expect(select.options.length).toBeGreaterThan(0);
    });

    const select = screen.getByTestId('default-currency-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, EUR.id);

    const saveBtn = screen.getByTestId('save-default-currency');
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.patch).toHaveBeenCalledWith(
        '/organizations/default-currency',
        { currencyId: EUR.id },
      );
    });
  });
});
