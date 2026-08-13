import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExpenseCategoriesPage } from '../expense-categories';

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

function makeExpenseCategory(overrides: Partial<{
  id: string;
  name: string;
  description: string | null;
}> = {}) {
  return {
    id: 'cat-1',
    name: 'Loyer',
    description: null,
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
      <ExpenseCategoriesPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ExpenseCategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it('affiche l\'état vide avec le CTA "Nouvelle catégorie"', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-expense-category')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucune catégorie de dépense/i)).toBeInTheDocument();
  });

  // ── État erreur ───────────────────────────────────────────────────────────

  it('affiche une bannière d\'erreur actionnable si le chargement échoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Erreur réseau')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /réessayer/i })).toBeInTheDocument();
    });
  });

  // ── État liste ────────────────────────────────────────────────────────────

  it('affiche la liste des catégories avec nom et description', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeExpenseCategory({ name: 'Loyer', description: 'Loyer mensuel du local' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Loyer'));
    expect(screen.getByText('Loyer mensuel du local')).toBeInTheDocument();
  });

  // ── Édition ───────────────────────────────────────────────────────────────

  it('affiche le formulaire pré-rempli à l\'édition', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeExpenseCategory({ name: 'Transport', description: 'Frais de transport' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Transport'));

    const editBtn = screen.getByLabelText('Modifier Transport');
    await userEvent.click(editBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/nom/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Transport');
    const descInput = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    expect(descInput.value).toBe('Frais de transport');
  });

  // ── Création ──────────────────────────────────────────────────────────────

  it('appelle POST /expense-categories à la soumission du formulaire de création', async () => {
    const category = makeExpenseCategory({ name: 'Électricité' });
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    mockApi.post.mockResolvedValue(category);
    renderPage();

    await waitFor(() => screen.getByTestId('add-expense-category'));
    await userEvent.click(screen.getByTestId('add-expense-category'));

    const nameInput = screen.getByLabelText(/nom/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Électricité');

    const submitBtn = screen.getByRole('button', { name: /enregistrer/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/expense-categories',
        expect.objectContaining({ name: 'Électricité' }),
      );
    });
  });

  // ── Suppression ───────────────────────────────────────────────────────────

  it('ouvre l\'AlertDialog de suppression en nommant la catégorie', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeExpenseCategory({ name: 'Loyer' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Loyer'));

    const deleteBtn = screen.getByLabelText('Supprimer Loyer');
    await userEvent.click(deleteBtn);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/"Loyer"/)).toBeInTheDocument();
  });

  it('appelle DELETE /expense-categories/:id à la confirmation de suppression', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeExpenseCategory({ id: 'cat-42', name: 'Loyer' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    mockApi.delete.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() => screen.getByText('Loyer'));

    await userEvent.click(screen.getByLabelText('Supprimer Loyer'));
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/expense-categories/cat-42'));
  });
});
