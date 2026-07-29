import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PosPage, { fractionToPercentString } from '../pos';
import { Toaster } from '../../components/ui/sonner';

// ─── Mock API ─────────────────────────────────────────────────────────────────

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../../lib/api';
const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WAREHOUSE_ID    = 'wh000001-0000-0000-0000-000000000001';
const CLIENT_WALKIN_ID = 'cli00001-0000-0000-0000-000000000001';
const CLIENT_OTHER_ID  = 'cli00002-0000-0000-0000-000000000002';
const PROD_A_ID = 'prod0001-0000-0000-0000-000000000001';
const PROD_B_ID = 'prod0002-0000-0000-0000-000000000002';
const SALE_ID   = 'sale0001-0000-0000-0000-000000000001';
const CASH_SESSION_ID = 'cs000001-0000-0000-0000-000000000001';

const warehouseResp = { data: [{ id: WAREHOUSE_ID, name: 'Entrepôt Principal' }], total: 1, page: 1, limit: 200 };

// Le client "Walk-in" (code === 1) est présélectionné automatiquement dès le chargement.
const clientResp = {
  data: [
    { id: CLIENT_WALKIN_ID, code: 1, name: 'Walk-in' },
    { id: CLIENT_OTHER_ID, code: 2, name: 'Client Fidèle' },
  ],
  total: 2,
  page: 1,
  limit: 200,
};

function makeProductA(overrides: Record<string, unknown> = {}) {
  return {
    id: PROD_A_ID,
    code: 'PROD-001',
    name: 'Produit Un',
    price: '1000',
    taxRate: '0.1925',
    taxMethod: 'percentage',
    quantity: '10',
    ...overrides,
  };
}

function makeProductB(overrides: Record<string, unknown> = {}) {
  return {
    id: PROD_B_ID,
    code: 'PROD-002',
    name: 'Produit Deux',
    price: '2000',
    taxRate: '0',
    taxMethod: 'percentage',
    quantity: '1',
    ...overrides,
  };
}

const calcTotalResp = {
  details: [],
  sumLines: '5000',
  taxAmount: '0',
  discount: '0',
  shipping: '0',
  grandTotal: '5000',
};

const emptyPaginated = { data: [], total: 0, page: 1, limit: 20 };

/**
 * Session de caisse OPEN par défaut — la plupart des tests exercent le panier avec une
 * session déjà ouverte. openingAmount délibérément distinct des fixtures grandTotal ('5000')
 * utilisées ailleurs dans ce fichier pour que `getByText` sur un montant ne matche jamais à
 * la fois le bandeau de session et le panier/reçu.
 */
const openSessionResp = {
  id: CASH_SESSION_ID,
  organizationId: 'org00001-0000-0000-0000-000000000001',
  reference: 'CS-2026-000001',
  warehouseId: WAREHOUSE_ID,
  userId: 'user0001-0000-0000-0000-000000000001',
  openingAmount: '10000',
  expectedClosingAmount: null,
  countedClosingAmount: null,
  variance: null,
  status: 'OPEN',
  notes: null,
  openedAt: '2026-07-28T08:00:00.000Z',
  closedAt: null,
};

/**
 * Route les GET par défaut (session de caisse courante, entrepôts, clients, recherche
 * produits) et les POST (calcul de total, ouverture de session) / PATCH (clôture de session).
 * `products` peut être surchargé par test pour simuler grille vide/erreur, `initialSession`
 * pour simuler l'absence de session (gate S23b). La session est un état mutable partagé par
 * les mocks GET/POST/PATCH pour que le cycle ouverture → fermeture reste cohérent d'un appel
 * à l'autre (comme le ferait réellement le serveur).
 */
function setupDefaultMocks(products: unknown[] = [makeProductA()], initialSession: unknown = openSessionResp) {
  let session: unknown = initialSession;

  mockApi.get.mockImplementation((path: string) => {
    if (path.includes('/cash-sessions/current'))  return Promise.resolve(session);
    if (path.includes('/warehouses'))              return Promise.resolve(warehouseResp);
    if (path.includes('/partners/clients'))        return Promise.resolve(clientResp);
    if (path.includes('/pos/products/search'))     return Promise.resolve(products);
    return Promise.resolve(emptyPaginated);
  });
  mockApi.post.mockImplementation((path: string, body?: unknown) => {
    if (path === '/pos/calculate-total') return Promise.resolve(calcTotalResp);
    if (path === '/cash-sessions/open') {
      const b = body as { openingAmount: string };
      session = { ...openSessionResp, openingAmount: b.openingAmount };
      return Promise.resolve(session);
    }
    return Promise.reject(new Error(`POST non mocké : ${path}`));
  });
  mockApi.patch.mockImplementation((path: string, body?: unknown) => {
    if (path === `/cash-sessions/${CASH_SESSION_ID}/close`) {
      const b = body as { countedClosingAmount: string };
      const opening = Number((session as { openingAmount: string }).openingAmount);
      const counted = Number(b.countedClosingAmount);
      const closed = {
        ...(session as Record<string, unknown>),
        status: 'CLOSED',
        expectedClosingAmount: String(opening),
        countedClosingAmount: b.countedClosingAmount,
        variance: String(counted - opening),
      };
      session = null;
      return Promise.resolve(closed);
    }
    return Promise.reject(new Error(`PATCH non mocké : ${path}`));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PosPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

async function selectWarehouse() {
  renderPage();
  // Attendre que la liste des entrepôts soit chargée (l'option n'existe qu'après résolution du GET).
  await waitFor(() => expect(screen.getByText('Entrepôt Principal')).toBeInTheDocument());
  await userEvent.selectOptions(screen.getByTestId('pos-warehouse-select'), WAREHOUSE_ID);
}

/** Sélectionne l'entrepôt puis attend que la grille produit affiche PROD-001. */
async function selectWarehouseAndWaitProducts() {
  await selectWarehouse();
  await waitFor(() => expect(screen.getByTestId('product-card-PROD-001')).toBeInTheDocument());
}

/** Ajoute Produit Un au panier (clic carte) et attend que le total calculé soit affiché. */
async function addProductAndWaitTotal() {
  await selectWarehouseAndWaitProducts();
  await userEvent.click(screen.getByTestId('product-card-PROD-001'));
  await waitFor(() => expect(screen.getByLabelText('Quantité — Produit Un')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('5 000 XAF')).toBeInTheDocument());
}

/** Ouvre le Sheet de paiement ("Passer au paiement") — Client/Mode de paiement/Encaisser y vivent. */
async function openCheckout() {
  await userEvent.click(screen.getByTestId('checkout-button'));
  await waitFor(() => expect(screen.getByTestId('pos-client-select')).toBeInTheDocument());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fractionToPercentString', () => {
  it('convertit une fraction en pourcentage direct (0.1925 → 19.25)', () => {
    expect(fractionToPercentString('0.1925')).toBe('19.25');
  });

  it('gère la fraction nulle (produit non taxé)', () => {
    expect(fractionToPercentString('0')).toBe('0');
  });

  it('gère une fraction représentant 100% (1 → 100)', () => {
    expect(fractionToPercentString('1')).toBe('100');
  });

  it('arrondit à 3 décimales pour rester compatible avec le regex serveur (\\d+(\\.\\d{1,3})?)', () => {
    expect(fractionToPercentString('0.123456')).toBe('12.346');
  });
});

describe('PosPage — Recherche produit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("n'appelle pas la recherche produit tant qu'aucun entrepôt n'est sélectionné", async () => {
    setupDefaultMocks();
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Sélectionnez un entrepôt pour commencer.')).toBeInTheDocument(),
    );
    expect(mockApi.get).not.toHaveBeenCalledWith(expect.stringContaining('/pos/products/search'));
  });

  it('affiche la grille de produits une fois un entrepôt sélectionné', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    expect(screen.getByText('Produit Un')).toBeInTheDocument();
    expect(screen.getByText('PROD-001')).toBeInTheDocument();
  });

  it("respecte le debounce de 300ms sur la saisie de recherche (pas d'appel immédiat)", async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    mockApi.get.mockClear();
    const searchInput = screen.getByLabelText('Rechercher un produit');
    await userEvent.type(searchInput, 'PR');

    // Immédiatement après la frappe : pas encore d'appel réseau pour cette requête.
    expect(mockApi.get).not.toHaveBeenCalledWith(expect.stringContaining('q=PR'));

    // Après le débounce (300ms), l'appel part avec la requête complète.
    await waitFor(
      () => expect(mockApi.get).toHaveBeenCalledWith(expect.stringContaining('q=PR')),
      { timeout: 1500 },
    );
  });

  it("affiche l'état vide si la recherche ne retourne aucun résultat", async () => {
    setupDefaultMocks([]);
    await selectWarehouse();

    await waitFor(() => expect(screen.getByText('Aucun produit')).toBeInTheDocument());
  });

  it("affiche un état d'erreur actionnable si la recherche produit échoue", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/cash-sessions/current')) return Promise.resolve(openSessionResp);
      if (path.includes('/warehouses'))          return Promise.resolve(warehouseResp);
      if (path.includes('/partners/clients'))    return Promise.resolve(clientResp);
      if (path.includes('/pos/products/search')) return Promise.reject(new Error('Erreur réseau'));
      return Promise.resolve(emptyPaginated);
    });
    mockApi.post.mockImplementation((path: string) => {
      if (path === '/pos/calculate-total') return Promise.resolve(calcTotalResp);
      return Promise.reject(new Error(`POST non mocké : ${path}`));
    });
    await selectWarehouse();

    await waitFor(() => expect(screen.getByText('Impossible de charger les produits.')).toBeInTheDocument());
  });
});

describe('PosPage — Ajout au panier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('un clic sur une carte produit ajoute une ligne au panier avec quantité 1', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    await userEvent.click(screen.getByTestId('product-card-PROD-001'));

    const qtyInput = (await screen.findByLabelText('Quantité — Produit Un')) as HTMLInputElement;
    expect(qtyInput.value).toBe('1');
  });

  it('un second clic sur la même carte incrémente la quantité existante', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    await userEvent.click(screen.getByTestId('product-card-PROD-001'));
    await screen.findByLabelText('Quantité — Produit Un');
    await userEvent.click(screen.getByTestId('product-card-PROD-001'));

    await waitFor(() => {
      const qtyInput = screen.getByLabelText('Quantité — Produit Un') as HTMLInputElement;
      expect(qtyInput.value).toBe('2');
    });
  });

  it('le scan (code exact + Entrée) ajoute le produit correspondant au panier', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    const searchInput = screen.getByLabelText('Rechercher un produit');
    await userEvent.type(searchInput, 'PROD-001{Enter}');

    await waitFor(() => expect(screen.getByLabelText('Quantité — Produit Un')).toBeInTheDocument());
    expect((screen.getByLabelText('Quantité — Produit Un') as HTMLInputElement).value).toBe('1');
    // Le champ de recherche est vidé après un scan réussi.
    await waitFor(() => expect(searchInput).toHaveValue(''));
  });

  it("un clic qui dépasserait le stock disponible n'incrémente pas le panier au-delà du stock et notifie", async () => {
    setupDefaultMocks([makeProductB({ quantity: '1' })]);
    await selectWarehouse();
    await waitFor(() => expect(screen.getByTestId('product-card-PROD-002')).toBeInTheDocument());

    // Premier clic : ajoute 1 unité (stock disponible = 1).
    await userEvent.click(screen.getByTestId('product-card-PROD-002'));
    await screen.findByLabelText('Quantité — Produit Deux');

    // Second clic : dépasserait le stock disponible → pas d'incrément au-delà de 1, toast d'erreur.
    await userEvent.click(screen.getByTestId('product-card-PROD-002'));

    expect((screen.getByLabelText('Quantité — Produit Deux') as HTMLInputElement).value).toBe('1');
    await waitFor(() =>
      expect(screen.getByText(/Stock insuffisant pour Produit Deux : quantité disponible 1\./)).toBeInTheDocument(),
    );
  });
});

describe('PosPage — Calcul du total', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appelle POST /pos/calculate-total après ajout au panier et affiche le grandTotal renvoyé", async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    await userEvent.click(screen.getByTestId('product-card-PROD-001'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/pos/calculate-total', expect.any(Object)));
    await waitFor(() => expect(screen.getByText('5 000 XAF')).toBeInTheDocument());
  });
});

describe('PosPage — Validation CASH', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('le bouton Encaisser est désactivé tant que le montant reçu est vide ou insuffisant, puis actif avec la monnaie correcte', async () => {
    setupDefaultMocks([makeProductA()]);
    await addProductAndWaitTotal();
    await openCheckout();

    expect(screen.getByTestId('encaisser-button')).toBeDisabled();

    const amountInput = screen.getByLabelText('Montant reçu');
    await userEvent.type(amountInput, '2000');
    // 2000 < grandTotal (5000) → toujours désactivé.
    expect(screen.getByTestId('encaisser-button')).toBeDisabled();

    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '6000');

    await waitFor(() => expect(screen.getByTestId('encaisser-button')).not.toBeDisabled());
    // "1 000 XAF" apparaît aussi dans le prix unitaire de la carte produit et la ligne panier
    // (des <span>) — la monnaie à rendre est le seul <p> à afficher ce montant.
    expect(screen.getByText('1 000 XAF', { selector: 'p' })).toBeInTheDocument();
  });
});

describe('PosPage — Validation MOBILE_MONEY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Prépare panier + mode MOBILE_MONEY, clique "Encaisser" puis attend l'état d'attente.
   * Le GET /sales/:id (premier poll, déclenché immédiatement par usePosSaleStatus) est routé
   * vers une promesse contrôlée manuellement : comme la résolution mockée est quasi instantanée
   * (microtâche), la laisser se résoudre tout de suite ferait sauter l'état "attente" avant que
   * le test ne puisse l'observer. On la résout explicitement plus tard, dans chaque test.
   */
  async function submitMobileMoney(): Promise<(saleDetailResponse: Record<string, unknown>) => void> {
    let resolveSaleStatus!: (value: Record<string, unknown>) => void;
    const saleStatusPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveSaleStatus = resolve;
    });

    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/cash-sessions/current')) return Promise.resolve(openSessionResp);
      if (path.includes('/warehouses'))          return Promise.resolve(warehouseResp);
      if (path.includes('/partners/clients'))    return Promise.resolve(clientResp);
      if (path.includes('/pos/products/search')) return Promise.resolve([makeProductA()]);
      if (path === `/sales/${SALE_ID}`)          return saleStatusPromise;
      return Promise.resolve(emptyPaginated);
    });
    mockApi.post.mockImplementation((path: string) => {
      if (path === '/pos/calculate-total') return Promise.resolve(calcTotalResp);
      if (path === '/pos/sales') {
        return Promise.resolve({
          id: SALE_ID,
          reference: 'VTE-2026-000001',
          date: '2026-07-27T00:00:00.000Z',
          clientId: CLIENT_WALKIN_ID,
          warehouseId: WAREHOUSE_ID,
          taxAmount: '0',
          discount: '0',
          grandTotal: '5000',
          status: 'AWAITING_PAYMENT',
          cancelReason: null,
          paymentLink: 'https://pay.example.com/xyz',
        });
      }
      return Promise.reject(new Error(`POST non mocké : ${path}`));
    });

    await addProductAndWaitTotal();
    await openCheckout();
    await userEvent.selectOptions(screen.getByTestId('pos-payment-method-select'), 'MOBILE_MONEY');

    await userEvent.click(screen.getByTestId('encaisser-button'));
    await waitFor(() => expect(screen.getByText('En attente de confirmation du paiement')).toBeInTheDocument());

    return resolveSaleStatus;
  }

  it('affiche l\'état d\'attente puis le reçu quand le polling renvoie COMPLETED', async () => {
    const resolveSaleStatus = await submitMobileMoney();

    resolveSaleStatus({
      id: SALE_ID,
      reference: 'VTE-2026-000001',
      date: '2026-07-27T00:00:00.000Z',
      clientId: CLIENT_WALKIN_ID,
      warehouseId: WAREHOUSE_ID,
      taxAmount: '0',
      discount: '0',
      grandTotal: '5000',
      status: 'COMPLETED',
      cancelReason: null,
      details: [{ id: 'd1', productId: PROD_A_ID, quantity: '1', price: '1000', total: '5000' }],
    });

    await waitFor(() => expect(screen.getByText('Vente encaissée avec succès.')).toBeInTheDocument());
    expect(screen.getByText('Nouvelle vente')).toBeInTheDocument();
  });

  it("affiche le message d'expiration avec la raison serveur quand le polling renvoie CANCELLED", async () => {
    const resolveSaleStatus = await submitMobileMoney();

    resolveSaleStatus({
      id: SALE_ID,
      reference: 'VTE-2026-000001',
      date: '2026-07-27T00:00:00.000Z',
      clientId: CLIENT_WALKIN_ID,
      warehouseId: WAREHOUSE_ID,
      taxAmount: '0',
      discount: '0',
      grandTotal: '5000',
      status: 'CANCELLED',
      cancelReason: 'Délai de paiement mobile money dépassé (10 min).',
    });

    await waitFor(() => expect(screen.getByText('Paiement mobile money expiré')).toBeInTheDocument());
    expect(screen.getByText('Délai de paiement mobile money dépassé (10 min).')).toBeInTheDocument();
    expect(screen.getByText('Réessayer')).toBeInTheDocument();
  });
});

describe('PosPage — Erreurs de création de vente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Prépare panier + montant reçu suffisant pour rendre "Encaisser" utilisable, en mode CASH. */
  async function prepareReadyToSubmit() {
    setupDefaultMocks([makeProductA()]);
    await addProductAndWaitTotal();
    await openCheckout();
    await userEvent.type(screen.getByLabelText('Montant reçu'), '6000');
    await waitFor(() => expect(screen.getByTestId('encaisser-button')).not.toBeDisabled());
  }

  it('stock insuffisant (400) : le message serveur est affiché tel quel et le panier reste intact', async () => {
    await prepareReadyToSubmit();
    mockApi.post.mockImplementation((path: string) => {
      if (path === '/pos/calculate-total') return Promise.resolve(calcTotalResp);
      if (path === '/pos/sales') return Promise.reject(new Error('Stock insuffisant pour le produit Produit Un.'));
      return Promise.reject(new Error(`POST non mocké : ${path}`));
    });

    await userEvent.click(screen.getByTestId('encaisser-button'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Stock insuffisant pour le produit Produit Un.');
    // Le panier n'est pas vidé après l'échec.
    expect(screen.getByLabelText('Quantité — Produit Un')).toBeInTheDocument();
  });

  it('conflit de concurrence (409) : message clair affiché, permet de réessayer sans crash', async () => {
    await prepareReadyToSubmit();
    mockApi.post.mockImplementation((path: string) => {
      if (path === '/pos/calculate-total') return Promise.resolve(calcTotalResp);
      if (path === '/pos/sales') return Promise.reject(new Error('Conflit de version sur le stock — réessayez.'));
      return Promise.reject(new Error(`POST non mocké : ${path}`));
    });

    await userEvent.click(screen.getByTestId('encaisser-button'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Conflit de version sur le stock — réessayez.');

    // Le bouton "Encaisser" redevient utilisable (pas bloqué en chargement, pas de crash).
    await waitFor(() => expect(screen.getByTestId('encaisser-button')).not.toBeDisabled());
    expect(screen.getByText('Encaisser')).toBeInTheDocument();
  });
});

describe('PosPage — Session de caisse (S23b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bloque le panier et affiche le formulaire d'ouverture tant qu'aucune session de caisse n'est ouverte", async () => {
    setupDefaultMocks([makeProductA()], null);
    await selectWarehouse();

    await waitFor(() =>
      expect(screen.getByText('Ouvrez votre session de caisse pour commencer à encaisser')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('opening-amount-input')).toBeInTheDocument();
    expect(screen.queryByTestId('product-card-PROD-001')).not.toBeInTheDocument();
    expect(screen.queryByTestId('checkout-button')).not.toBeInTheDocument();
  });

  it('ouvre une session via le formulaire puis affiche la grille produits et le bandeau de session', async () => {
    setupDefaultMocks([makeProductA()], null);
    await selectWarehouse();
    await waitFor(() => expect(screen.getByTestId('opening-amount-input')).toBeInTheDocument());

    await userEvent.clear(screen.getByTestId('opening-amount-input'));
    await userEvent.type(screen.getByTestId('opening-amount-input'), '5000');
    await userEvent.click(screen.getByTestId('open-session-button'));

    await waitFor(() => expect(screen.getByTestId('product-card-PROD-001')).toBeInTheDocument());
    expect(screen.getByText('CS-2026-000001')).toBeInTheDocument();
    expect(screen.getByTestId('close-session-button')).toBeInTheDocument();
  });

  it('clôture la session et affiche le récapitulatif avec un écart positif (excédent, badge succès)', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    await userEvent.click(screen.getByTestId('close-session-button'));
    await waitFor(() => expect(screen.getByTestId('counted-amount-input')).toBeInTheDocument());

    // Fond de caisse 10000 (openSessionResp), aucune vente CASH rattachée dans ce test →
    // expectedClosingAmount = 10000 ; compté = 10300 → écart = +300 (excédent).
    await userEvent.type(screen.getByTestId('counted-amount-input'), '10300');
    await userEvent.click(screen.getByTestId('confirm-close-session-button'));

    await waitFor(() => expect(screen.getByTestId('close-session-summary')).toBeInTheDocument());
    expect(screen.getByText(/Excédent/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('close-session-summary-dismiss'));
    await waitFor(() =>
      expect(screen.getByText('Ouvrez votre session de caisse pour commencer à encaisser')).toBeInTheDocument(),
    );
  });

  it('clôture la session et affiche un écart négatif (manque, badge danger)', async () => {
    setupDefaultMocks([makeProductA()]);
    await selectWarehouseAndWaitProducts();

    await userEvent.click(screen.getByTestId('close-session-button'));
    await waitFor(() => expect(screen.getByTestId('counted-amount-input')).toBeInTheDocument());

    // Fond de caisse 10000, compté 9800 → écart = -200 (manque).
    await userEvent.type(screen.getByTestId('counted-amount-input'), '9800');
    await userEvent.click(screen.getByTestId('confirm-close-session-button'));

    await waitFor(() => expect(screen.getByTestId('close-session-summary')).toBeInTheDocument());
    expect(screen.getByText(/Manque/)).toBeInTheDocument();
  });

  it('le bouton "Clôturer la caisse" est désactivé pendant le paiement (Sheet ouvert)', async () => {
    setupDefaultMocks([makeProductA()]);
    await addProductAndWaitTotal();
    await openCheckout();

    expect(screen.getByTestId('close-session-button')).toBeDisabled();
  });
});
