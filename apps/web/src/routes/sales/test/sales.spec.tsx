import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SalesPage from '../index';
import { Toaster } from '../../../components/ui/sonner';

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

const CLIENT_ID    = 'client01-0000-0000-0000-000000000001';
const WAREHOUSE_ID = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID      = 'prod0000-0000-0000-0000-000000000001';
const SALE_ID       = 'sale0001-0000-0000-0000-000000000001';

function makeSale() {
  return {
    id: SALE_ID,
    reference: 'VTE-2026-000001',
    date: '2026-07-26T00:00:00.000Z',
    clientId: CLIENT_ID,
    warehouseId: WAREHOUSE_ID,
    taxRate: '0',
    taxAmount: '0',
    discount: '0',
    shipping: '0',
    grandTotal: '15000',
    paidAmount: '0',
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    notes: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    details: [
      { id: 'd1', productId: PROD_ID, productVariantId: null, saleUnitId: null, price: '15000', taxAmount: '0', taxMethod: 'percentage', discount: '0', discountMethod: 'percentage', quantity: '1', total: '15000' },
    ],
  };
}

const clientResp    = { data: [{ id: CLIENT_ID, name: 'Client Test' }], total: 1, page: 1, limit: 200 };
const warehouseResp = { data: [{ id: WAREHOUSE_ID, name: 'Entrepôt Principal' }], total: 1, page: 1, limit: 200 };
const productResp   = { data: [{ id: PROD_ID, code: 'PROD-001', name: 'Produit Test', price: '15000' }], total: 1, page: 1, limit: 500 };
const emptySales    = { data: [], total: 0, page: 1, limit: 20 };
const saleListResp  = { data: [makeSale()], total: 1, page: 1, limit: 20 };

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SalesPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SalesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients'))  return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))         return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))   return Promise.resolve(productResp);
      if (path.includes('/sales?'))             return Promise.resolve(saleListResp);
      if (path.includes('/sales/'))             return Promise.resolve(makeSale());
      return Promise.resolve(emptySales);
    });
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche des skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucune vente", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients'))  return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))         return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))   return Promise.resolve(productResp);
      return Promise.resolve(emptySales);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucune vente')).toBeInTheDocument());
  });

  // ── État liste ────────────────────────────────────────────────────────────

  it('affiche la liste des ventes avec référence et total', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('VTE-2026-000001')).toBeInTheDocument());
    expect(screen.getByText('15 000 XAF')).toBeInTheDocument();
  });

  // ── Formulaire de création ────────────────────────────────────────────────

  it('ouvre le Sheet de création en cliquant sur "Nouvelle vente"', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Nouvelle vente'));

    await userEvent.click(screen.getAllByText('Nouvelle vente')[0]!);

    await waitFor(() => expect(screen.getAllByText('Nouvelle vente').length).toBeGreaterThan(1));
    expect(screen.getByText('Enregistrer')).toBeInTheDocument();
  });

  // ── Toast après création ──────────────────────────────────────────────────

  it('affiche un toast avec la référence après création', async () => {
    mockApi.post.mockResolvedValue(makeSale());

    renderPage();
    await waitFor(() => screen.getByText('Nouvelle vente'));
    await userEvent.click(screen.getAllByText('Nouvelle vente')[0]!);

    await waitFor(() => screen.getByTestId('client-select'));

    await userEvent.selectOptions(screen.getByTestId('client-select'), CLIENT_ID);
    await userEvent.selectOptions(screen.getByTestId('warehouse-select'), WAREHOUSE_ID);

    const productSelects = screen.getAllByRole('combobox');
    const rowProductSelect = productSelects.find((el) => el.innerHTML.includes('PROD-001'))!;
    await userEvent.selectOptions(rowProductSelect, PROD_ID);

    const quantityInput = screen.getByPlaceholderText('1');
    await userEvent.type(quantityInput, '1');

    await userEvent.click(screen.getByText('Enregistrer'));

    await waitFor(() => expect(screen.getByText(/Vente créée. Référence : VTE-2026-000001/)).toBeInTheDocument());
  });
});

// ─── Paiements (S20) ────────────────────────────────────────────────────────────

const PAYMENT_ID = 'pay00001-0000-0000-0000-000000000001';

function makePaymentSale(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    organizationId: 'org00001-0000-0000-0000-000000000001',
    saleId: SALE_ID,
    userId: 'user0001-0000-0000-0000-000000000001',
    date: '2026-07-26T00:00:00.000Z',
    reference: 'PAY-2026-000001',
    amount: '15000',
    method: 'CASH',
    change: '0',
    notes: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('SalesPage — Paiements (S20)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Route la vente/l'historique des paiements en plus des fixtures partagées (clients, entrepôts, produits). */
  function mockGet(saleDetail: ReturnType<typeof makeSale>, payments: unknown[]) {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/payments'))          return Promise.resolve(payments);
      if (path.includes('/sales?'))            return Promise.resolve(saleListResp);
      if (path.includes('/sales/'))            return Promise.resolve(saleDetail);
      return Promise.resolve(emptySales);
    });
  }

  async function openDetail() {
    renderPage();
    await waitFor(() => screen.getByText('VTE-2026-000001'));
    await userEvent.click(screen.getByText('VTE-2026-000001'));
    await waitFor(() => expect(screen.getByText(/Paiements \(/)).toBeInTheDocument());
  }

  // ── Ouverture du Sheet / visibilité conditionnelle ────────────────────────

  it('le bouton "Ajouter un paiement" ouvre le Sheet de règlement', async () => {
    mockGet(makeSale(), []); // paymentStatus UNPAID (paidAmount '0')
    await openDetail();

    await userEvent.click(screen.getByText('Ajouter un paiement'));

    // Le libellé apparaît deux fois une fois le Sheet ouvert : le bouton déclencheur
    // (toujours présent, la vue détail reste montée derrière le Sheet) + le titre du Sheet.
    await waitFor(() => expect(screen.getAllByText('Ajouter un paiement').length).toBeGreaterThan(1));
    expect(screen.getByText('Solde restant')).toBeInTheDocument();
  });

  it('le bouton "Ajouter un paiement" est absent quand paymentStatus === PAID', async () => {
    mockGet({ ...makeSale(), paidAmount: '15000', paymentStatus: 'PAID' }, []);
    await openDetail();

    expect(screen.queryByText('Ajouter un paiement')).not.toBeInTheDocument();
  });

  // ── Raccourci "Solder" ─────────────────────────────────────────────────────

  it('le raccourci "Solder" pré-remplit exactement le solde restant affiché', async () => {
    // grandTotal 15000 − paidAmount 5000 = solde 10000
    mockGet({ ...makeSale(), paidAmount: '5000', paymentStatus: 'PARTIAL' }, []);
    await openDetail();

    await userEvent.click(screen.getByText('Ajouter un paiement'));
    await waitFor(() => screen.getByText('Solde restant'));
    expect(screen.getByText('10 000 XAF')).toBeInTheDocument();

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(amountInput.value).toBe('10000.000');

    // L'utilisateur modifie le montant, puis "Solder" doit le ramener exactement au solde.
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '3000');
    expect(amountInput.value).toBe('3000');

    await userEvent.click(screen.getByText('Solder'));
    // jsdom réapplique l'algorithme de sanitisation des <input type="number"> lors d'une
    // réaffectation programmatique ultérieure (retire les zéros de fin) — on compare donc
    // la valeur numérique, ce qui reste la garantie fonctionnelle attendue : exactement le solde.
    expect(Number(amountInput.value)).toBe(10000);
  });

  // ── Soumission réussie ───────────────────────────────────────────────────────

  it('soumission réussie → toast de confirmation et invalidation déclenchant un refetch de l\'historique', async () => {
    let paymentsCallCount = 0;
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/payments')) {
        paymentsCallCount += 1;
        // Avant soumission : historique vide. Après invalidation (refetch) : le paiement créé apparaît.
        return Promise.resolve(paymentsCallCount === 1 ? [] : [makePaymentSale()]);
      }
      if (path.includes('/sales?')) return Promise.resolve(saleListResp);
      if (path.includes('/sales/')) return Promise.resolve(makeSale());
      return Promise.resolve(emptySales);
    });
    mockApi.post.mockResolvedValue(makePaymentSale());

    await openDetail();
    await userEvent.click(screen.getByText('Ajouter un paiement'));
    await waitFor(() => screen.getByText('Solde restant'));

    await userEvent.click(screen.getByText('Enregistrer'));

    await waitFor(() => expect(screen.getByText('Paiement enregistré.')).toBeInTheDocument());
    // La liste des paiements a été refetchée (invalidateQueries) et affiche le nouveau paiement.
    await waitFor(() => expect(screen.getByText('PAY-2026-000001')).toBeInTheDocument());
    expect(paymentsCallCount).toBeGreaterThan(1);
  });

  // ── Erreur serveur (400) ──────────────────────────────────────────────────────

  it('le serveur renvoie 400 (montant > solde) → message d\'erreur affiché, pas de crash', async () => {
    mockGet(makeSale(), []);
    mockApi.post.mockRejectedValue(new Error('Le montant dépasse le solde restant (15000.000).'));

    await openDetail();
    await userEvent.click(screen.getByText('Ajouter un paiement'));
    await waitFor(() => screen.getByText('Solde restant'));

    await userEvent.click(screen.getByText('Enregistrer'));

    await waitFor(() =>
      expect(screen.getByText('Le montant dépasse le solde restant (15000.000).')).toBeInTheDocument(),
    );
    // Pas de crash : le Sheet de paiement reste affiché et utilisable.
    expect(screen.getByText('Enregistrer')).toBeInTheDocument();
  });
});

// ─── Validation de vente (S21) ──────────────────────────────────────────────────

describe('SalesPage — Validation (S21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Route la vente/l'historique des paiements (vide, non pertinent ici) en plus des fixtures partagées. */
  function mockGet(saleDetail: ReturnType<typeof makeSale>) {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/payments'))          return Promise.resolve([]);
      if (path.includes('/sales?'))            return Promise.resolve(saleListResp);
      if (path.includes('/sales/'))            return Promise.resolve(saleDetail);
      return Promise.resolve(emptySales);
    });
  }

  async function openDetail() {
    renderPage();
    await waitFor(() => screen.getByText('VTE-2026-000001'));
    await userEvent.click(screen.getByText('VTE-2026-000001'));
    await waitFor(() => expect(screen.getByText(/Paiements \(/)).toBeInTheDocument());
  }

  // ── Visibilité conditionnelle du bouton ──────────────────────────────────

  it('le bouton "Valider la vente" est visible quand status === PENDING', async () => {
    mockGet(makeSale()); // status: 'PENDING' par défaut
    await openDetail();

    expect(screen.getByText('Valider la vente')).toBeInTheDocument();
  });

  it('le bouton "Valider la vente" est absent quand status !== PENDING (ex. COMPLETED)', async () => {
    mockGet({ ...makeSale(), status: 'COMPLETED' });
    await openDetail();

    expect(screen.queryByText('Valider la vente')).not.toBeInTheDocument();
  });

  // ── Validation réussie ────────────────────────────────────────────────────

  it('validation réussie → toast de succès et badge de statut mis à jour (PATCH .../validate)', async () => {
    let saleDetailCallCount = 0;
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/payments'))          return Promise.resolve([]);
      if (path.includes('/sales?'))            return Promise.resolve(saleListResp);
      if (path.includes('/sales/')) {
        saleDetailCallCount += 1;
        // Avant validation : PENDING. Après invalidation (refetch déclenché par le succès
        // de la mutation, queryKey ['sale', id]) : COMPLETED — le badge doit suivre.
        return Promise.resolve(
          saleDetailCallCount === 1 ? makeSale() : { ...makeSale(), status: 'COMPLETED' },
        );
      }
      return Promise.resolve(emptySales);
    });
    mockApi.patch.mockResolvedValue({ ...makeSale(), status: 'COMPLETED' });

    await openDetail();

    // Le libellé "En attente" apparaît deux fois avant validation : la ligne de liste
    // (toujours montée derrière le Sheet) + le badge de la vue détail.
    expect(screen.getAllByText('En attente').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByText('Valider la vente'));

    await waitFor(() =>
      expect(screen.getByText('Vente validée. Stock mis à jour.')).toBeInTheDocument(),
    );
    expect(mockApi.patch).toHaveBeenCalledWith(`/sales/${SALE_ID}/validate`, {});
    // Le badge de statut (un <span>, à distinguer de l'<option> "Terminée" du filtre de
    // statuts toujours présent dans le DOM) reflète le COMPLETED renvoyé après invalidation/refetch.
    await waitFor(() =>
      expect(screen.getByText('Terminée', { selector: 'span' })).toBeInTheDocument(),
    );
  });

  // ── Erreur serveur ────────────────────────────────────────────────────────

  it('le serveur renvoie une erreur (ex. 409 conflit de concurrence) → toast d\'erreur, pas de crash', async () => {
    mockGet(makeSale());
    mockApi.patch.mockRejectedValue(new Error('Conflit de version sur le stock.'));

    await openDetail();
    await userEvent.click(screen.getByText('Valider la vente'));

    await waitFor(() =>
      expect(screen.getByText('Erreur lors de la validation.')).toBeInTheDocument(),
    );
    // Le statut reste PENDING, le bouton "Valider la vente" reste affiché et utilisable.
    expect(screen.getByText('Valider la vente')).toBeInTheDocument();
  });
});
