import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import QuotationsPage from '../index';
import { Toaster } from '../../../components/ui/sonner';
import { TooltipProvider } from '../../../components/ui/tooltip';

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

const CLIENT_ID     = 'client01-0000-0000-0000-000000000001';
const WAREHOUSE_ID   = 'wh000001-0000-0000-0000-000000000001';
const PROD_ID        = 'prod0000-0000-0000-0000-000000000001';
const QUOTATION_ID   = 'quot0001-0000-0000-0000-000000000001';
const SALE_ID        = 'sale0001-0000-0000-0000-000000000001';

function makeQuotation(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTATION_ID,
    reference: 'DEV-2026-000001',
    date: '2026-07-26T00:00:00.000Z',
    clientId: CLIENT_ID,
    warehouseId: WAREHOUSE_ID,
    taxRate: '0',
    taxAmount: '0',
    discount: '0',
    shipping: '0',
    grandTotal: '15000',
    status: 'PENDING',
    notes: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    client: { id: CLIENT_ID, name: 'Client Test', email: 'client@test.cm', phone: '+237600000000' },
    warehouse: { id: WAREHOUSE_ID, name: 'Entrepôt Principal' },
    details: [
      { id: 'd1', productId: PROD_ID, productVariantId: null, quoteUnitId: null, price: '15000', taxAmount: '0', taxMethod: 'percentage', discount: '0', discountMethod: 'percentage', quantity: '1', total: '15000' },
    ],
    ...overrides,
  };
}

const clientResp    = { data: [{ id: CLIENT_ID, name: 'Client Test' }], total: 1, page: 1, limit: 200 };
const warehouseResp = { data: [{ id: WAREHOUSE_ID, name: 'Entrepôt Principal' }], total: 1, page: 1, limit: 200 };
const productResp   = { data: [{ id: PROD_ID, code: 'PROD-001', name: 'Produit Test', price: '15000' }], total: 1, page: 1, limit: 500 };
const emptyQuotations = { data: [], total: 0, page: 1, limit: 20 };
const quotationListResp = { data: [makeQuotation()], total: 1, page: 1, limit: 20 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `QuotationDetailView` utilise `<Tooltip>` (boutons d'envoi email/SMS) — le rendu de test
 * doit être enveloppé dans `TooltipProvider`, mirror exact de sales.spec.tsx.
 */
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <QuotationsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Route la liste + le détail d'un devis donné, en plus des fixtures partagées. */
function mockGet(quotationDetail: ReturnType<typeof makeQuotation>) {
  mockApi.get.mockImplementation((path: string) => {
    if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
    if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
    if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
    if (path.includes('/quotations?'))       return Promise.resolve({ data: [quotationDetail], total: 1, page: 1, limit: 20 });
    if (path.includes('/quotations/'))       return Promise.resolve(quotationDetail);
    return Promise.resolve(emptyQuotations);
  });
}

async function openDetail(reference = 'DEV-2026-000001') {
  renderPage();
  await waitFor(() => screen.getByText(reference));
  await userEvent.click(screen.getByText(reference));
  await waitFor(() => expect(screen.getByText('Convertir en vente')).toBeInTheDocument());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QuotationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/quotations?'))       return Promise.resolve(quotationListResp);
      if (path.includes('/quotations/'))       return Promise.resolve(makeQuotation());
      return Promise.resolve(emptyQuotations);
    });
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche des skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucun devis", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      return Promise.resolve(emptyQuotations);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucun devis')).toBeInTheDocument());
  });

  // ── État erreur ───────────────────────────────────────────────────────────

  it("affiche l'état erreur avec un bouton de réessai", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/quotations?'))       return Promise.reject(new Error('network'));
      return Promise.resolve(emptyQuotations);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Impossible de charger les devis.')).toBeInTheDocument());
    expect(screen.getByText('Réessayer')).toBeInTheDocument();
  });

  // ── État liste ────────────────────────────────────────────────────────────

  it('affiche la liste des devis avec référence, total et statut « Brouillon »', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('DEV-2026-000001')).toBeInTheDocument());
    expect(screen.getByText('15 000 XAF')).toBeInTheDocument();
    // "Brouillon" apparaît aussi comme option du filtre statut — on vérifie la cellule du
    // tableau spécifiquement pour éviter l'ambiguïté multi-match.
    expect(screen.getByRole('cell', { name: 'Brouillon' })).toBeInTheDocument();
  });

  it('affiche le statut « Converti » pour un devis COMPLETED et « Annulé » pour un devis CANCELLED', async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/partners/clients')) return Promise.resolve(clientResp);
      if (path.includes('/warehouses'))        return Promise.resolve(warehouseResp);
      if (path.includes('/catalog/products'))  return Promise.resolve(productResp);
      if (path.includes('/quotations?')) {
        return Promise.resolve({
          data: [
            makeQuotation({ id: 'q-completed', reference: 'DEV-2026-000002', status: 'COMPLETED' }),
            makeQuotation({ id: 'q-cancelled', reference: 'DEV-2026-000003', status: 'CANCELLED' }),
          ],
          total: 2,
          page: 1,
          limit: 20,
        });
      }
      return Promise.resolve(emptyQuotations);
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Converti' })).toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'Annulé' })).toBeInTheDocument();
    // Les libellés de vente ne doivent jamais apparaître sur cet écran.
    expect(screen.queryByText('Terminée')).not.toBeInTheDocument();
    expect(screen.queryByText('En attente')).not.toBeInTheDocument();
  });

  // ── Formulaire de création ────────────────────────────────────────────────

  it('ouvre le Sheet de création en cliquant sur "Nouveau devis"', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Nouveau devis'));

    await userEvent.click(screen.getAllByText('Nouveau devis')[0]!);

    await waitFor(() => expect(screen.getAllByText('Nouveau devis').length).toBeGreaterThan(1));
    expect(screen.getByText('Créer le devis')).toBeInTheDocument();
  });

  it('affiche un toast avec la référence après création', async () => {
    mockApi.post.mockResolvedValue(makeQuotation());

    renderPage();
    await waitFor(() => screen.getByText('Nouveau devis'));
    await userEvent.click(screen.getAllByText('Nouveau devis')[0]!);

    await waitFor(() => screen.getByTestId('client-select'));

    await userEvent.selectOptions(screen.getByTestId('client-select'), CLIENT_ID);
    await userEvent.selectOptions(screen.getByTestId('warehouse-select'), WAREHOUSE_ID);

    const productSelects = screen.getAllByRole('combobox');
    const rowProductSelect = productSelects.find((el) => el.innerHTML.includes('PROD-001'))!;
    await userEvent.selectOptions(rowProductSelect, PROD_ID);

    const quantityInput = screen.getByPlaceholderText('1');
    await userEvent.type(quantityInput, '1');

    await userEvent.click(screen.getByText('Créer le devis'));

    await waitFor(() => expect(screen.getByText(/Devis créé. Référence : DEV-2026-000001/)).toBeInTheDocument());
  });
});

// ─── Détail — envoi email/SMS ──────────────────────────────────────────────────

describe('QuotationsPage — Envoi email/SMS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('les boutons d\'envoi sont actifs quand le devis est PENDING et le client a email + téléphone', async () => {
    mockGet(makeQuotation());
    await openDetail();

    expect(screen.getByRole('button', { name: /Envoyer par email/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Envoyer par SMS/ })).toBeEnabled();
  });

  it('le bouton email est désactivé si le client n\'a pas d\'adresse email', async () => {
    mockGet(makeQuotation({ client: { id: CLIENT_ID, name: 'Client Test', email: null, phone: '+237600000000' } }));
    await openDetail();

    expect(screen.getByRole('button', { name: /Envoyer par email/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Envoyer par SMS/ })).toBeEnabled();
  });

  it('les deux boutons d\'envoi sont désactivés si le devis n\'est plus PENDING (ex. COMPLETED)', async () => {
    mockGet(makeQuotation({ status: 'COMPLETED' }));
    await openDetail();

    expect(screen.getByRole('button', { name: /Envoyer par email/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Envoyer par SMS/ })).toBeDisabled();
  });

  it('un envoi réussi affiche « Envoi en cours… », jamais « Envoyé »', async () => {
    mockGet(makeQuotation());
    mockApi.post.mockResolvedValue({ status: 'queued' });
    await openDetail();

    await userEvent.click(screen.getByRole('button', { name: /Envoyer par email/ }));

    await waitFor(() => expect(screen.getByText('Envoi en cours…')).toBeInTheDocument());
    expect(mockApi.post).toHaveBeenCalledWith(`/quotations/${QUOTATION_ID}/send`, { channel: 'email' });
  });
});

// ─── Détail — conversion en vente ──────────────────────────────────────────────

describe('QuotationsPage — Conversion en vente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('le bouton "Convertir en vente" est actif quand status === PENDING', async () => {
    mockGet(makeQuotation());
    await openDetail();

    expect(screen.getByRole('button', { name: /Convertir en vente/ })).toBeEnabled();
  });

  it('le bouton "Convertir en vente" est désactivé quand status !== PENDING (ex. COMPLETED)', async () => {
    mockGet(makeQuotation({ status: 'COMPLETED' }));
    await openDetail();

    expect(screen.getByRole('button', { name: /Convertir en vente/ })).toBeDisabled();
  });

  it('confirmer la conversion appelle POST /quotations/:id/convert et affiche un toast avec la référence de la vente créée', async () => {
    mockGet(makeQuotation());
    mockApi.post.mockResolvedValue({ id: SALE_ID, reference: 'VTE-2026-000009' });
    await openDetail();

    await userEvent.click(screen.getByRole('button', { name: /Convertir en vente/ }));
    await waitFor(() => expect(screen.getByText('Convertir le devis DEV-2026-000001 en vente ?')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Confirmer la conversion'));

    expect(mockApi.post).toHaveBeenCalledWith(`/quotations/${QUOTATION_ID}/convert`, {});
    await waitFor(() => expect(screen.getByText(/Devis converti. Vente créée : VTE-2026-000009/)).toBeInTheDocument());
  });

  it('le bouton "Retour" de l\'AlertDialog ferme la boîte sans appeler l\'API', async () => {
    mockGet(makeQuotation());
    await openDetail();

    await userEvent.click(screen.getByRole('button', { name: /Convertir en vente/ }));
    await waitFor(() => expect(screen.getByText('Convertir le devis DEV-2026-000001 en vente ?')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Retour'));

    await waitFor(() => expect(screen.queryByText('Convertir le devis DEV-2026-000001 en vente ?')).not.toBeInTheDocument());
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

// ─── Détail — suppression ───────────────────────────────────────────────────────

describe('QuotationsPage — Suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('le bouton "Supprimer" est visible dans le détail quand status === PENDING', async () => {
    mockGet(makeQuotation());
    await openDetail();

    expect(screen.getByRole('button', { name: /Supprimer/ })).toBeInTheDocument();
  });

  it('le bouton "Supprimer" est absent du détail quand status !== PENDING (ex. COMPLETED)', async () => {
    mockGet(makeQuotation({ status: 'COMPLETED' }));
    await openDetail();

    expect(screen.queryByRole('button', { name: /Supprimer/ })).not.toBeInTheDocument();
  });

  it('la suppression appelle DELETE /quotations/:id et affiche un toast de confirmation', async () => {
    mockGet(makeQuotation());
    mockApi.delete.mockResolvedValue(undefined);
    await openDetail();

    await userEvent.click(screen.getByRole('button', { name: /Supprimer/ }));
    await waitFor(() => expect(screen.getByText('Supprimer le devis DEV-2026-000001 ?')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }));

    expect(mockApi.delete).toHaveBeenCalledWith(`/quotations/${QUOTATION_ID}`);
    await waitFor(() => expect(screen.getByText('Devis supprimé.')).toBeInTheDocument());
  });
});
