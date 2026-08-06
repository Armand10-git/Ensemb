import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PurchaseReturnsPage from '../index';
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

const PURCHASE_ID        = 'purc0001-0000-0000-0000-000000000001';
const PURCHASE_RETURN_ID = 'pret0001-0000-0000-0000-000000000001';
const WAREHOUSE_ID        = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID              = 'prod0000-0000-0000-0000-000000000001';

/** Retour tel que renvoyé par GET /purchase-returns/:id (avec relations purchase/warehouse/details). */
function makePurchaseReturnDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PURCHASE_RETURN_ID,
    reference: 'RAC-2026-000001',
    date: '2026-07-26T00:00:00.000Z',
    userId: 'user0001-0000-0000-0000-000000000001',
    purchaseId: PURCHASE_ID,
    warehouseId: WAREHOUSE_ID,
    taxRate: '0',
    taxAmount: '0',
    discount: '0',
    shipping: '0',
    grandTotal: '5000',
    paidAmount: '0',
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    notes: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    purchase: { id: PURCHASE_ID, reference: 'ACH-2026-000001' },
    warehouse: { id: WAREHOUSE_ID, name: 'Entrepôt Principal' },
    details: [
      {
        id: 'rd1',
        purchaseDetailId: 'd1',
        productId: PROD_ID,
        productVariantId: null,
        returnUnitId: null,
        price: '5000',
        taxAmount: '0',
        taxMethod: 'percentage',
        discount: '0',
        discountMethod: 'percentage',
        quantity: '1',
        total: '5000',
      },
    ],
    ...overrides,
  };
}

/** Ligne telle que renvoyée par GET /purchase-returns (liste paginée — pas de relations, cf. service). */
function makePurchaseReturnListItem(overrides: Record<string, unknown> = {}) {
  const full = makePurchaseReturnDetail() as Record<string, unknown>;
  delete full.purchase;
  delete full.warehouse;
  delete full.details;
  return { ...full, ...overrides };
}

const warehouseResp = { data: [{ id: WAREHOUSE_ID, name: 'Entrepôt Principal' }], total: 1, page: 1, limit: 200 };
const productResp   = { data: [{ id: PROD_ID, code: 'PROD-001', name: 'Produit Test', price: '5000' }], total: 1, page: 1, limit: 500 };
const emptyList      = { data: [], total: 0, page: 1, limit: 20 };
const listResp        = { data: [makePurchaseReturnListItem()], total: 1, page: 1, limit: 20 };

const REFUND_ID = 'pref0001-0000-0000-0000-000000000001';

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    organizationId: 'org00001-0000-0000-0000-000000000001',
    saleReturnId: null,
    purchaseReturnId: PURCHASE_RETURN_ID,
    userId: 'user0001-0000-0000-0000-000000000001',
    date: '2026-07-26T00:00:00.000Z',
    reference: 'REM-2026-000001',
    amount: '5000',
    method: 'CASH',
    change: '0',
    notes: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PurchaseReturnsPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** Route par défaut des fixtures partagées (entrepôts, produits, liste, détail, remboursements vides). */
function mockGet(detail: ReturnType<typeof makePurchaseReturnDetail>, payments: unknown[] = []) {
  mockApi.get.mockImplementation((path: string) => {
    if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
    if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
    if (path.includes('/payments'))          return Promise.resolve(payments);
    if (path.includes('/purchase-returns?')) return Promise.resolve(listResp);
    if (path.includes('/purchase-returns/')) return Promise.resolve(detail);
    return Promise.resolve(emptyList);
  });
}

async function openDetail() {
  renderPage();
  await waitFor(() => screen.getByText('RAC-2026-000001'));
  await userEvent.click(screen.getByText('RAC-2026-000001'));
  await waitFor(() => expect(screen.getByText(/Remboursements \(/)).toBeInTheDocument());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PurchaseReturnsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet(makePurchaseReturnDetail());
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche des skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucun retour", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/warehouses'))       return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products')) return Promise.resolve(productResp);
      return Promise.resolve(emptyList);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Aucun retour d'achat")).toBeInTheDocument());
  });

  // ── État liste ────────────────────────────────────────────────────────────

  it('affiche la liste des retours avec référence et total', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('RAC-2026-000001')).toBeInTheDocument());
    expect(screen.getByText('5 000 XAF')).toBeInTheDocument();
  });

  // ── Détail — lignes en lecture seule ─────────────────────────────────────

  it('affiche les lignes du retour en lecture seule (produit, quantité, prix, total)', async () => {
    await openDetail();

    expect(screen.getByText('PROD-001 — Produit Test')).toBeInTheDocument();
    // Quantité, prix unitaire et total apparaissent en texte simple (cellules de tableau),
    // jamais dans un champ éditable — aucun input/spinbutton ne porte ces valeurs.
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5 000 XAF').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('spinbutton').length).toBe(0);
    expect(screen.queryAllByRole('textbox').filter((el) => (el as HTMLInputElement).value === '1').length).toBe(0);
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('le bouton "Valider le retour" déclenche PATCH .../validate et affiche un toast de succès', async () => {
    mockApi.patch.mockResolvedValue(makePurchaseReturnDetail({ status: 'COMPLETED' }));

    await openDetail();
    await userEvent.click(screen.getByText('Valider le retour'));

    await waitFor(() =>
      expect(screen.getByText('Retour validé. Stock mis à jour.')).toBeInTheDocument(),
    );
    expect(mockApi.patch).toHaveBeenCalledWith(`/purchase-returns/${PURCHASE_RETURN_ID}/validate`, {});
  });

  it('le bouton "Valider le retour" est absent quand status === COMPLETED', async () => {
    mockGet(makePurchaseReturnDetail({ status: 'COMPLETED', paymentStatus: 'UNPAID' }));
    await openDetail();

    expect(screen.queryByText('Valider le retour')).not.toBeInTheDocument();
  });

  // ── Ajout de remboursement ───────────────────────────────────────────────

  it('ajoute un remboursement : ouvre le Sheet, remplit le formulaire, POST sur la bonne route, toast de succès', async () => {
    mockGet(makePurchaseReturnDetail({ status: 'COMPLETED', paymentStatus: 'UNPAID' }), []);
    mockApi.post.mockResolvedValue(makeRefund());

    await openDetail();
    await userEvent.click(screen.getByText('Ajouter un remboursement'));
    await waitFor(() => screen.getByText('Solde restant'));

    const amountInput = screen.getByRole('spinbutton') as HTMLInputElement;
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '5000');

    await userEvent.click(screen.getByText('Enregistrer'));

    await waitFor(() => expect(screen.getByText('Remboursement enregistré.')).toBeInTheDocument());
    expect(mockApi.post).toHaveBeenCalledWith(
      `/purchase-returns/${PURCHASE_RETURN_ID}/payments`,
      expect.objectContaining({ amount: '5000', method: 'CASH' }),
    );
  });

  // ── Deep-link ─────────────────────────────────────────────────────────────

  it('ouvre automatiquement le détail via le deep-link ?open=<id>', async () => {
    window.history.pushState({}, '', `/purchase-returns?open=${PURCHASE_RETURN_ID}`);

    renderPage();

    await waitFor(() => expect(screen.getByText(/Retour RAC-2026-000001/)).toBeInTheDocument());
    expect(screen.getByText(/Remboursements \(/)).toBeInTheDocument();

    // Nettoyage — évite de polluer les autres tests via l'URL du jsdom partagé.
    window.history.pushState({}, '', '/purchase-returns');
  });
});
