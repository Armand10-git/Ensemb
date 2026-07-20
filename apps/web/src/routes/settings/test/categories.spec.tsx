import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CategoriesPage } from '../categories';

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

function makeCategory(overrides: Partial<{
  id: string;
  code: string;
  name: string;
}> = {}) {
  return {
    id: 'cat-1',
    code: 'ELEC',
    name: 'Électronique',
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
      <CategoriesPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'état vide avec le CTA "Nouvelle catégorie"', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-category')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucune catégorie/i)).toBeInTheDocument();
  });

  it('affiche la liste avec les codes en badges monospace', async () => {
    mockApi.get.mockResolvedValue({
      data: [
        makeCategory({ id: 'cat-1', code: 'ELEC', name: 'Électronique' }),
        makeCategory({ id: 'cat-2', code: 'ALI', name: 'Alimentation' }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('ELEC')).toBeInTheDocument();
      expect(screen.getByText('ALI')).toBeInTheDocument();
    });
    expect(screen.getByText('Électronique')).toBeInTheDocument();
    expect(screen.getByText('Alimentation')).toBeInTheDocument();
    // Codes en badge monospace
    const elecBadge = screen.getByText('ELEC');
    expect(elecBadge.className).toContain('font-mono');
  });

  it('ouvre l\'AlertDialog de suppression en nommant la catégorie', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeCategory({ id: 'cat-1', code: 'ELEC', name: 'Électronique' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Électronique'));

    const deleteBtn = screen.getByLabelText('Supprimer ELEC');
    await userEvent.click(deleteBtn);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/ELEC/)).toBeInTheDocument();
  });

  it('affiche une bannière d\'erreur actionnable si le chargement échoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });

  it('force le code en majuscules lors de la saisie', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => screen.getByTestId('add-category'));
    await userEvent.click(screen.getByTestId('add-category'));

    const codeInput = screen.getByLabelText(/code/i) as HTMLInputElement;
    await userEvent.type(codeInput, 'elec');

    expect(codeInput.value).toBe('ELEC');
  });

  it('appelle POST /catalog/categories à la soumission du formulaire de création', async () => {
    const cat = makeCategory({ code: 'ALI', name: 'Alimentation' });
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    mockApi.post.mockResolvedValue(cat);
    renderPage();

    await waitFor(() => screen.getByTestId('add-category'));
    await userEvent.click(screen.getByTestId('add-category'));

    const codeInput = screen.getByLabelText(/code/i);
    await userEvent.clear(codeInput);
    await userEvent.type(codeInput, 'ALI');

    const nameInput = screen.getByLabelText(/nom/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Alimentation');

    const submitBtn = screen.getByRole('button', { name: /enregistrer/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/catalog/categories',
        expect.objectContaining({ code: 'ALI', name: 'Alimentation' }),
      );
    });
  });

  it('filtre les catégories localement par code et nom', async () => {
    mockApi.get.mockResolvedValue({
      data: [
        makeCategory({ id: 'cat-1', code: 'ELEC', name: 'Électronique' }),
        makeCategory({ id: 'cat-2', code: 'ALI', name: 'Alimentation' }),
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Électronique'));

    const searchInput = screen.getByPlaceholderText(/rechercher/i);
    await userEvent.type(searchInput, 'ali');

    expect(screen.queryByText('Électronique')).not.toBeInTheDocument();
    expect(screen.getByText('Alimentation')).toBeInTheDocument();
  });
});
