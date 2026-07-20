import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CustomersPage from '../customers';

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

function makeClient(overrides: Partial<{
  id: string; code: number; name: string; email: string | null;
  phone: string | null; city: string | null;
}> = {}) {
  return {
    id: 'cli-1',
    code: 1,
    name: 'Acme Corp',
    email: 'acme@test.cm',
    phone: null,
    country: null,
    city: 'Douala',
    address: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePaginated(clients: ReturnType<typeof makeClient>[]) {
  return { data: clients, total: clients.length, page: 1, limit: 20 };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomersPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CustomersPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('affiche les skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'état vide avec le CTA "Nouveau client"', async () => {
    mockApi.get.mockResolvedValue(makePaginated([]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-client')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucun client/i)).toBeInTheDocument();
  });

  it('affiche la liste des clients avec code monospace', async () => {
    mockApi.get.mockResolvedValue(makePaginated([makeClient({ code: 42, name: 'Acme Corp' })]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
    });
    expect(screen.getByTestId('client-row')).toBeInTheDocument();
  });

  it('la recherche filtre la liste (debounce)', async () => {
    const user = userEvent.setup({ delay: null });
    mockApi.get.mockResolvedValue(makePaginated([makeClient()]));
    renderPage();

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));

    const input = screen.getByTestId('search-input');
    await user.type(input, 'acme');

    await waitFor(() => {
      const calls = mockApi.get.mock.calls as [string][];
      expect(calls.some(([url]) => url.includes('search=acme'))).toBe(true);
    }, { timeout: 1000 });
  });

  it('affiche le rapport d\'erreurs après un import partiel', async () => {
    mockApi.get.mockResolvedValue(makePaginated([makeClient()]));
    mockApi.upload.mockResolvedValue({ imported: 2, errors: [{ line: 4, message: 'email: invalid email' }] });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('clients-table')).toBeInTheDocument());

    // Simule un upload de fichier CSV
    const file = new File(['name,email\nA,a@b.cm\nB,bad'], 'clients.csv', { type: 'text/csv' });
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
    // Distingue la liste et l'export par URL
    mockApi.get.mockImplementation((url: string) => {
      if (url.includes('export/excel')) return Promise.resolve({ jobId: 'job-1' });
      return Promise.resolve(makePaginated([makeClient()]));
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
