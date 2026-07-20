import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WarehousesPage } from '../warehouses';

// ─── Mock API ────────────────────────────────────────────────────────────────

vi.mock('../../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../../../lib/api';
const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeWarehouse(overrides: Partial<{
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
}> = {}) {
  return {
    id: 'wh-1',
    name: 'Principal',
    address: null,
    isDefault: false,
    version: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WarehousesPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WarehousesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'etat vide avec le CTA "Ajouter un entrepot"', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-warehouse')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucun entrepôt/i)).toBeInTheDocument();
  });

  it('affiche la liste des entrepots avec leurs noms', async () => {
    mockApi.get.mockResolvedValue({
      data: [
        makeWarehouse({ id: 'wh-1', name: 'Principal', isDefault: true }),
        makeWarehouse({ id: 'wh-2', name: 'Secondaire' }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Principal')).toBeInTheDocument();
      expect(screen.getByText('Secondaire')).toBeInTheDocument();
    });
    // "Par défaut" apparaît dans le header ET dans le badge — on vérifie le badge spécifiquement
    const badge = screen.getByText('Par défaut', { selector: 'span' });
    expect(badge).toBeInTheDocument();
  });

  it('ouvre l\'AlertDialog de suppression en nommant l\'entrepot', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeWarehouse({ id: 'wh-1', name: 'Principal' }), makeWarehouse({ id: 'wh-2', name: 'Secondaire' })],
      total: 2,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Principal'));

    const deleteBtn = screen.getByLabelText('Supprimer Principal');
    await userEvent.click(deleteBtn);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/"Principal"/)).toBeInTheDocument();
  });

  it('affiche une banniere d\'erreur avec bouton Reessayer si le chargement echoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });

  it('appelle POST /warehouses a la soumission du formulaire de creation', async () => {
    const wh = makeWarehouse({ name: 'Nouvel entrepôt' });
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    mockApi.post.mockResolvedValue(wh);
    renderPage();

    await waitFor(() => screen.getByTestId('add-warehouse'));
    await userEvent.click(screen.getByTestId('add-warehouse'));

    const input = screen.getByLabelText(/nom/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'Nouvel entrepôt');

    const submitBtn = screen.getByRole('button', { name: /enregistrer/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith('/warehouses', expect.objectContaining({ name: 'Nouvel entrepôt' }));
    });
  });
});
