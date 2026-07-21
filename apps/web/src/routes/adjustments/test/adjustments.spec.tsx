import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdjustmentsPage from '../index';

// ─── Mock Socket.io (connexion réseau non disponible en test) ─────────────────

vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// ─── Mock API ─────────────────────────────────────────────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WH_ID   = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID = 'prod0000-0000-0000-0000-000000000001';
const ADJ_ID  = 'adj00001-0000-0000-0000-000000000001';

function makeAdjustment(status: 'DRAFT' | 'VALIDATED' = 'DRAFT') {
  return {
    id: ADJ_ID,
    reference: 'ADJ-2026-000001',
    date: '2026-07-21T00:00:00.000Z',
    warehouseId: WH_ID,
    userId: 'user-1',
    note: null,
    status,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    details: [
      { id: 'd1', productId: PROD_ID, productVariantId: null, type: 'ADDITION', quantity: '5', unitCost: '0' },
    ],
  };
}

const warehouseResp = { data: [{ id: WH_ID, name: 'Entrepôt principal' }], total: 1, page: 1, limit: 200 };
const productResp   = { data: [{ id: PROD_ID, code: 'PROD-001', name: 'Produit Test' }], total: 1, page: 1, limit: 500 };
const emptyAdj      = { data: [], total: 0, page: 1, limit: 20 };
const adjListResp   = { data: [makeAdjustment()], total: 1, page: 1, limit: 20 };

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdjustmentsPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdjustmentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/warehouses'))             return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))       return Promise.resolve(productResp);
      if (path.includes('/inventory/adjustments?')) return Promise.resolve(adjListResp);
      if (path.includes('/inventory/adjustments/')) return Promise.resolve(makeAdjustment());
      return Promise.resolve(emptyAdj);
    });
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche des skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    const skeletons = document.querySelectorAll('div[style*="shimmer"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucun ajustement", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/warehouses'))       return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products')) return Promise.resolve(productResp);
      return Promise.resolve(emptyAdj);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucun ajustement')).toBeInTheDocument());
  });

  // ── État erreur ───────────────────────────────────────────────────────────

  it("affiche Réessayer en cas d'erreur API", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/warehouses'))             return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))       return Promise.resolve(productResp);
      if (path.includes('/inventory/adjustments?')) return Promise.reject(new Error('Erreur réseau'));
      return Promise.resolve(emptyAdj);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Réessayer')).toBeInTheDocument());
  });

  // ── État succès ───────────────────────────────────────────────────────────

  it('affiche la liste des ajustements avec référence et statut', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ADJ-2026-000001')).toBeInTheDocument());
    // "Brouillon" apparaît à la fois dans le filtre <option> et dans le badge de statut
    expect(screen.getAllByText('Brouillon').length).toBeGreaterThanOrEqual(1);
  });

  // ── Formulaire de création ────────────────────────────────────────────────

  it('ouvre le Sheet de création en cliquant sur "Nouvel ajustement"', async () => {
    renderPage();
    await waitFor(() => screen.getByText('+ Nouvel ajustement'));

    await userEvent.click(screen.getByText('+ Nouvel ajustement'));

    await waitFor(() => expect(screen.getByText('Nouvel ajustement')).toBeInTheDocument());
    expect(screen.getByText('Enregistrer en brouillon')).toBeInTheDocument();
    expect(screen.getByText('Valider le stock')).toBeInTheDocument();
  });

  it("le bouton 'Valider le stock' est désactivé si la liste de lignes est vide ou incomplète", async () => {
    renderPage();
    await waitFor(() => screen.getByText('+ Nouvel ajustement'));
    await userEvent.click(screen.getByText('+ Nouvel ajustement'));

    await waitFor(() => screen.getByText('Valider le stock'));

    const validateBtn = screen.getByText('Valider le stock').closest('button')!;
    // Aucun entrepôt sélectionné ni quantité → bouton désactivé
    expect(validateBtn).toBeDisabled();
  });

  it('ajoute une ligne supplémentaire via "+ Ajouter une ligne"', async () => {
    renderPage();
    await waitFor(() => screen.getByText('+ Nouvel ajustement'));
    await userEvent.click(screen.getByText('+ Nouvel ajustement'));

    await waitFor(() => screen.getByText('+ Ajouter une ligne'));

    const productSelects = () => document.querySelectorAll('select[value]');
    const before = productSelects().length;

    await userEvent.click(screen.getByText('+ Ajouter une ligne'));

    await waitFor(() => {
      // Il y a maintenant un nombre supérieur d'éléments de formulaire
      expect(screen.getAllByText('— Produit —').length).toBeGreaterThanOrEqual(2);
    });
    void before; // utilisé pour éviter le warning
  });

  // ── Toast après validation ────────────────────────────────────────────────

  it('affiche un toast "Stock mis à jour" après validation depuis le détail', async () => {
    mockApi.patch.mockResolvedValue(makeAdjustment('VALIDATED'));
    // Re-fetch après validation
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/warehouses'))             return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))       return Promise.resolve(productResp);
      if (path.includes('/inventory/adjustments?')) return Promise.resolve(adjListResp);
      if (path.includes('/inventory/adjustments/')) return Promise.resolve(makeAdjustment('DRAFT'));
      return Promise.resolve(emptyAdj);
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('ADJ-2026-000001')).toBeInTheDocument());

    // Ouvrir le détail
    await userEvent.click(screen.getByText('Voir'));

    await waitFor(() => expect(screen.getByText('Valider — mettre à jour le stock')).toBeInTheDocument());

    // Valider
    await userEvent.click(screen.getByText('Valider — mettre à jour le stock'));

    await waitFor(() => expect(screen.getByText('Stock mis à jour. Ajustement validé.')).toBeInTheDocument());
  });
});
