import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SuppliersPage from '../suppliers';

// ─── Mock API ─────────────────────────────────────────────────────────────────

vi.mock('../../../lib/api', () => ({
  api: {
    get:    vi.fn(),
    post:   vi.fn(),
    patch:  vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}));

import { api } from '../../../lib/api';
const mockApi = api as unknown as {
  get:    ReturnType<typeof vi.fn>;
  post:   ReturnType<typeof vi.fn>;
  patch:  ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<{
  id: string; code: number; name: string; email: string | null;
  phone: string | null; city: string | null;
}> = {}) {
  return {
    id: 'prv-1',
    code: 1,
    name: 'Fournisseur Sarl',
    email: 'contact@fournisseur.cm',
    phone: null,
    country: null,
    city: 'Yaoundé',
    address: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePaginated(providers: ReturnType<typeof makeProvider>[]) {
  return { data: providers, total: providers.length, page: 1, limit: 20 };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SuppliersPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SuppliersPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('affiche les skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'état vide avec le CTA "Nouveau fournisseur"', async () => {
    mockApi.get.mockResolvedValue(makePaginated([]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-provider')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucun fournisseur/i)).toBeInTheDocument();
  });

  it('affiche la liste des fournisseurs avec code monospace', async () => {
    mockApi.get.mockResolvedValue(makePaginated([makeProvider({ code: 7, name: 'Fournisseur Sarl' })]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Fournisseur Sarl')).toBeInTheDocument();
      expect(screen.getByText('7')).toBeInTheDocument();
    });
    expect(screen.getByTestId('provider-row')).toBeInTheDocument();
  });

  it('la recherche filtre la liste (debounce)', async () => {
    const user = userEvent.setup({ delay: null });
    mockApi.get.mockResolvedValue(makePaginated([makeProvider()]));
    renderPage();

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

    const input = screen.getByTestId('search-input');
    await user.type(input, 'sarl');

    await waitFor(() => {
      const calls = mockApi.get.mock.calls as [string][];
      expect(calls.some(([url]) => url.includes('search=sarl'))).toBe(true);
    }, { timeout: 1000 });
  });

  it('affiche le rapport d\'erreurs après un import partiel', async () => {
    mockApi.get.mockResolvedValue(makePaginated([makeProvider()]));
    mockApi.upload.mockResolvedValue({ imported: 1, errors: [{ line: 3, message: 'email: invalid email' }] });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('providers-table')).toBeInTheDocument());

    const file = new File(['name,email\nA,a@b.cm\nB,bad'], 'providers.csv', { type: 'text/csv' });
    const fileInput = screen.getByTestId('csv-file-input');

    await act(async () => {
      await userEvent.upload(fileInput, file);
    });

    await waitFor(() => {
      expect(screen.getByTestId('import-report')).toBeInTheDocument();
      expect(screen.getByTestId('import-errors')).toBeInTheDocument();
    });
  });

  it('toast "Export en cours…" déclenché sur clic Exporter', async () => {
    const user = userEvent.setup({ delay: null });
    mockApi.get.mockImplementation((url: string) => {
      if (url.includes('export/excel')) return Promise.resolve({ jobId: 'job-1' });
      return Promise.resolve(makePaginated([makeProvider()]));
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('export-excel-btn')).toBeInTheDocument());

    await user.click(screen.getByTestId('export-excel-btn'));

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  it('affiche l\'état d\'erreur avec bouton Réessayer', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur serveur'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });
});
