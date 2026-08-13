import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExpensesPage from '../index';
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

const CATEGORY_ID  = 'cat00001-0000-0000-0000-000000000001';
const WAREHOUSE_ID  = 'wh000001-0000-0000-0000-000000000001';
const EXPENSE_ID    = 'exp00001-0000-0000-0000-000000000001';

function makeExpense(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPENSE_ID,
    reference: 'DEP-2026-000001',
    date: '2026-07-26T00:00:00.000Z',
    expenseCategoryId: CATEGORY_ID,
    warehouseId: WAREHOUSE_ID,
    details: 'Facture Eneo du mois de juillet',
    amount: '25000',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

const categoryResp  = { data: [{ id: CATEGORY_ID, name: 'Électricité' }], total: 1, page: 1, limit: 200 };
const warehouseResp = { data: [{ id: WAREHOUSE_ID, name: 'Entrepôt Principal' }], total: 1, page: 1, limit: 200 };
const emptyExpenses = { data: [], total: 0, page: 1, limit: 20 };
const expenseListResp = { data: [makeExpense()], total: 1, page: 1, limit: 20 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExpensesPage />
      <Toaster />
    </QueryClientProvider>,
  );
}

function mockDefaultGet() {
  mockApi.get.mockImplementation((path: string) => {
    if (path.includes('/expense-categories')) return Promise.resolve(categoryResp);
    if (path.includes('/warehouses'))          return Promise.resolve(warehouseResp);
    if (path.includes('/expenses?'))           return Promise.resolve(expenseListResp);
    return Promise.resolve(emptyExpenses);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExpensesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaultGet();
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche des skeletons pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucune dépense", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/expense-categories')) return Promise.resolve(categoryResp);
      if (path.includes('/warehouses'))          return Promise.resolve(warehouseResp);
      return Promise.resolve(emptyExpenses);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucune dépense')).toBeInTheDocument());
  });

  // ── État erreur ───────────────────────────────────────────────────────────

  it("affiche l'état erreur avec un bouton de réessai", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/expense-categories')) return Promise.resolve(categoryResp);
      if (path.includes('/warehouses'))          return Promise.resolve(warehouseResp);
      if (path.includes('/expenses?'))           return Promise.reject(new Error('network'));
      return Promise.resolve(emptyExpenses);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Impossible de charger les dépenses.')).toBeInTheDocument());
    expect(screen.getByText('Réessayer')).toBeInTheDocument();
  });

  // ── État liste — résolution des noms ─────────────────────────────────────

  it('affiche la liste avec référence, montant et noms résolus (pas les UUID)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('DEP-2026-000001')).toBeInTheDocument());
    expect(screen.getByText('25 000 XAF')).toBeInTheDocument();
    // "Électricité"/"Entrepôt Principal" apparaissent aussi comme option de filtre — on
    // vérifie spécifiquement la cellule du tableau pour éviter l'ambiguïté multi-match.
    expect(screen.getByRole('cell', { name: 'Électricité' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Entrepôt Principal' })).toBeInTheDocument();
    expect(screen.queryByText(CATEGORY_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(WAREHOUSE_ID)).not.toBeInTheDocument();
  });

  // ── Création ──────────────────────────────────────────────────────────────

  it('ouvre le Sheet de création en cliquant sur "Nouvelle dépense"', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('add-expense'));
    await userEvent.click(screen.getByTestId('add-expense'));

    // "Nouvelle dépense" apparaît deux fois une fois le Sheet ouvert : le bouton déclencheur
    // (toujours monté derrière le Sheet) + le titre du Sheet — mirror sales.spec.tsx.
    await waitFor(() => expect(screen.getAllByText('Nouvelle dépense').length).toBeGreaterThan(1));
    expect(screen.getByLabelText(/détails/i)).toBeInTheDocument();
  });

  it('affiche un toast avec la référence après création', async () => {
    mockApi.post.mockResolvedValue(makeExpense());

    renderPage();
    await waitFor(() => screen.getByTestId('add-expense'));
    await userEvent.click(screen.getByTestId('add-expense'));

    await userEvent.selectOptions(screen.getByTestId('expense-category-select'), CATEGORY_ID);
    await userEvent.selectOptions(screen.getByTestId('expense-warehouse-select'), WAREHOUSE_ID);
    await userEvent.type(screen.getByLabelText(/détails/i), 'Achat de fournitures');
    await userEvent.type(screen.getByLabelText(/montant/i), '5000');

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(screen.getByText(/Dépense créée. Référence : DEP-2026-000001/)).toBeInTheDocument());
    expect(mockApi.post).toHaveBeenCalledWith(
      '/expenses',
      expect.objectContaining({ expenseCategoryId: CATEGORY_ID, warehouseId: WAREHOUSE_ID, amount: '5000' }),
    );
  });

  // ── Édition inline ────────────────────────────────────────────────────────

  it('un clic sur une ligne ouvre le Sheet d\'édition pré-rempli', async () => {
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));

    await userEvent.click(screen.getByText('DEP-2026-000001'));

    await waitFor(() => expect(screen.getByText('Modifier la dépense DEP-2026-000001')).toBeInTheDocument());
    expect((screen.getByLabelText(/détails/i) as HTMLTextAreaElement).value).toBe('Facture Eneo du mois de juillet');
    expect((screen.getByLabelText(/montant/i) as HTMLInputElement).value).toBe('25000');
  });

  it('modifie une dépense via PATCH /expenses/:id', async () => {
    mockApi.patch.mockResolvedValue(makeExpense({ amount: '30000' }));
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));

    await userEvent.click(screen.getByText('DEP-2026-000001'));
    await waitFor(() => screen.getByText('Modifier la dépense DEP-2026-000001'));

    const amountInput = screen.getByLabelText(/montant/i);
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '30000');

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(
      `/expenses/${EXPENSE_ID}`,
      expect.objectContaining({ amount: '30000' }),
    ));
    await waitFor(() => expect(screen.getByText('Dépense modifiée.')).toBeInTheDocument());
  });

  // ── Suppression ───────────────────────────────────────────────────────────

  it('ouvre l\'AlertDialog de suppression en nommant la dépense par sa référence', async () => {
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));

    await userEvent.click(screen.getByLabelText('Supprimer DEP-2026-000001'));

    expect(screen.getByText('Supprimer la dépense DEP-2026-000001 ?')).toBeInTheDocument();
  });

  it('appelle DELETE /expenses/:id à la confirmation de suppression', async () => {
    mockApi.delete.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));

    await userEvent.click(screen.getByLabelText('Supprimer DEP-2026-000001'));
    await waitFor(() => screen.getByText('Supprimer la dépense DEP-2026-000001 ?'));
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/expenses/${EXPENSE_ID}`));
    await waitFor(() => expect(screen.getByText('Dépense supprimée.')).toBeInTheDocument());
  });

  // ── Filtres ───────────────────────────────────────────────────────────────

  it('le filtre catégorie déclenche un nouvel appel avec expenseCategoryId', async () => {
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));
    mockApi.get.mockClear();

    const selects = screen.getAllByRole('combobox');
    const categorySelect = selects.find((el) => el.innerHTML.includes('Toutes les catégories'))!;
    await userEvent.selectOptions(categorySelect, CATEGORY_ID);

    await waitFor(() => expect(
      mockApi.get.mock.calls.some((call) => (call[0] as string).includes('/expenses?') && (call[0] as string).includes(`expenseCategoryId=${CATEGORY_ID}`)),
    ).toBe(true));
  });

  it('le filtre entrepôt déclenche un nouvel appel avec warehouseId', async () => {
    renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));
    mockApi.get.mockClear();

    const selects = screen.getAllByRole('combobox');
    const warehouseSelect = selects.find((el) => el.innerHTML.includes('Tous les entrepôts'))!;
    await userEvent.selectOptions(warehouseSelect, WAREHOUSE_ID);

    await waitFor(() => expect(
      mockApi.get.mock.calls.some((call) => (call[0] as string).includes('/expenses?') && (call[0] as string).includes(`warehouseId=${WAREHOUSE_ID}`)),
    ).toBe(true));
  });

  it('le filtre date déclenche un nouvel appel avec le paramètre date', async () => {
    const { container } = renderPage();
    await waitFor(() => screen.getByText('DEP-2026-000001'));
    mockApi.get.mockClear();

    const dateFilter = container.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateFilter, { target: { value: '2026-07-01' } });

    await waitFor(() => expect(
      mockApi.get.mock.calls.some((call) => (call[0] as string).includes('/expenses?') && (call[0] as string).includes('date=2026-07-01')),
    ).toBe(true));
  });
});
