import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SalesPage from '../index';

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
    const skeletons = document.querySelectorAll('div[style*="shimmer"]');
    expect(skeletons.length).toBeGreaterThan(0);
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

  it('ouvre le Sheet de création en cliquant sur "+ Nouvelle vente"', async () => {
    renderPage();
    await waitFor(() => screen.getByText('+ Nouvelle vente'));

    await userEvent.click(screen.getAllByText('+ Nouvelle vente')[0]!);

    await waitFor(() => expect(screen.getByText('Nouvelle vente')).toBeInTheDocument());
    expect(screen.getByText('Enregistrer')).toBeInTheDocument();
  });

  // ── Toast après création ──────────────────────────────────────────────────

  it('affiche un toast avec la référence après création', async () => {
    mockApi.post.mockResolvedValue(makeSale());

    renderPage();
    await waitFor(() => screen.getByText('+ Nouvelle vente'));
    await userEvent.click(screen.getAllByText('+ Nouvelle vente')[0]!);

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
