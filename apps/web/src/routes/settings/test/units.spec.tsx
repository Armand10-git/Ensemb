import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnitsPage } from '../units';

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUnit(overrides: Partial<{
  id: string;
  name: string;
  shortName: string;
  baseUnitId: string | null;
  baseUnit: { id: string; name: string; shortName: string } | null;
  operator: string;
  operatorValue: string;
}> = {}) {
  return {
    id: 'unit-1',
    name: 'Pièce',
    shortName: 'pcs',
    baseUnitId: null,
    baseUnit: null,
    operator: '*',
    operatorValue: '1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCarton(baseId: string) {
  return makeUnit({
    id: 'unit-2',
    name: 'Carton',
    shortName: 'ctn',
    baseUnitId: baseId,
    baseUnit: { id: baseId, name: 'Pièce', shortName: 'pcs' },
    operator: '*',
    operatorValue: '12',
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UnitsPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UnitsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'état vide avec le CTA "Nouvelle unité"', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-unit')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucune unité/i)).toBeInTheDocument();
  });

  it('affiche une bannière d\'erreur actionnable si le chargement échoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });

  it('affiche le tableau avec les unités (base et dérivée)', async () => {
    const piece = makeUnit({ id: 'unit-1' });
    const carton = makeCarton('unit-1');
    mockApi.get.mockResolvedValue({ data: [piece, carton], total: 2, page: 1, limit: 20 });
    renderPage();

    await waitFor(() => screen.getByText('Pièce'));
    expect(screen.getByText('Carton')).toBeInTheDocument();
    // Badge de hiérarchie visible pour le carton
    expect(screen.getByText(/Carton = 12 × Pièce/)).toBeInTheDocument();
    // Indicateur unité de base pour Pièce (au moins un élément avec ce texte)
    expect(screen.getAllByText(/unité de base/i).length).toBeGreaterThanOrEqual(1);
  });

  it('ouvre l\'AlertDialog de suppression en nommant l\'unité', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeUnit({ id: 'unit-1', name: 'Pièce' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Pièce'));

    const deleteBtn = screen.getByLabelText('Supprimer Pièce');
    await userEvent.click(deleteBtn);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/"Pièce"/)).toBeInTheDocument();
  });

  it('affiche les champs de conversion après activation du switch "Unité dérivée"', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeUnit({ id: 'unit-1', name: 'Pièce' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByTestId('add-unit'));
    await userEvent.click(screen.getByTestId('add-unit'));

    // Avant l'activation : pas de sélecteur d'unité de base
    expect(screen.queryByLabelText(/unité de base/i)).toBeNull();

    // Active le switch
    const switchBtn = screen.getByTestId('switch-derived');
    await userEvent.click(switchBtn);

    // Après l'activation : le sélecteur apparaît
    expect(screen.getByLabelText(/unité de base/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/facteur/i)).toBeInTheDocument();
  });

  it('affiche l\'aperçu "1 Carton = 12 Pièces" après saisie', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeUnit({ id: 'unit-base', name: 'Pièce' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByTestId('add-unit'));
    await userEvent.click(screen.getByTestId('add-unit'));

    // Ouvrir le switch dérivé
    await userEvent.click(screen.getByTestId('switch-derived'));

    // Remplir le nom
    const nameInput = screen.getByLabelText(/^nom \*/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Carton');

    // Sélectionner l'unité de base
    const select = screen.getByLabelText(/unité de base/i);
    await userEvent.selectOptions(select, 'unit-base');

    // Saisir le facteur
    const factorInput = screen.getByLabelText(/facteur/i);
    await userEvent.clear(factorInput);
    await userEvent.type(factorInput, '12');

    // L'aperçu doit apparaître
    await waitFor(() => {
      const preview = screen.getByTestId('conversion-preview');
      expect(preview).toBeInTheDocument();
      expect(preview.textContent).toMatch(/1 Carton = 12 Pièce/);
    });
  });

  it('affiche le formulaire pré-rempli à l\'édition', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeUnit({ id: 'unit-1', name: 'Pièce', shortName: 'pcs' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Pièce'));

    await userEvent.click(screen.getByLabelText('Modifier Pièce'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/^nom \*/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Pièce');
  });

  it('appelle POST /catalog/units à la soumission du formulaire de création', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    mockApi.post.mockResolvedValue(makeUnit({ name: 'Kg' }));
    renderPage();

    await waitFor(() => screen.getByTestId('add-unit'));
    await userEvent.click(screen.getByTestId('add-unit'));

    const nameInput = screen.getByLabelText(/^nom \*/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Kg');

    const shortNameInput = screen.getByLabelText(/nom court/i);
    await userEvent.clear(shortNameInput);
    await userEvent.type(shortNameInput, 'kg');

    const submitBtn = screen.getByRole('button', { name: /enregistrer/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/catalog/units',
        expect.objectContaining({ name: 'Kg' }),
      );
    });
  });
});
