import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrandsPage } from '../brands';

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

function makeBrand(overrides: Partial<{
  id: string;
  name: string;
  description: string | null;
  image: string | null;
}> = {}) {
  return {
    id: 'brand-1',
    name: 'Samsung',
    description: null,
    image: null,
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
      <BrandsPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BrandsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les lignes skeleton pendant le chargement', () => {
    mockApi.get.mockReturnValue(new Promise(() => {}));
    renderPage();
    const skeletons = document.querySelectorAll('[aria-busy="true"]');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('affiche l\'état vide avec le CTA "Nouvelle marque"', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('empty-add-brand')).toBeInTheDocument();
    });
    expect(screen.getByText(/aucune marque/i)).toBeInTheDocument();
  });

  it('affiche l\'avatar initiale si pas d\'image URL', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeBrand({ id: 'b-1', name: 'Samsung', image: null })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Samsung'));

    const avatar = screen.getByLabelText('Initiale Samsung');
    expect(avatar).toBeInTheDocument();
    expect(avatar.textContent).toBe('S');
  });

  it('affiche une image si image URL est fournie', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeBrand({ id: 'b-1', name: 'Apple', image: 'https://apple.com/logo.png' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Apple'));

    const img = screen.getByAltText('Logo Apple') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://apple.com/logo.png');
  });

  it('ouvre l\'AlertDialog de suppression en nommant la marque', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeBrand({ id: 'b-1', name: 'Samsung' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Samsung'));

    const deleteBtn = screen.getByLabelText('Supprimer Samsung');
    await userEvent.click(deleteBtn);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/"Samsung"/)).toBeInTheDocument();
  });

  it('affiche une bannière d\'erreur actionnable si le chargement échoue', async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/réessayer/i)).toBeInTheDocument();
    });
  });

  it('affiche le formulaire pré-rempli à l\'édition', async () => {
    mockApi.get.mockResolvedValue({
      data: [makeBrand({ id: 'b-1', name: 'Samsung', description: 'Marque coréenne' })],
      total: 1,
      page: 1,
      limit: 20,
    });
    renderPage();
    await waitFor(() => screen.getByText('Samsung'));

    const editBtn = screen.getByLabelText('Modifier Samsung');
    await userEvent.click(editBtn);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const nameInput = screen.getByLabelText(/nom/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Samsung');
    const descInput = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    expect(descInput.value).toBe('Marque coréenne');
  });

  it('appelle POST /catalog/brands à la soumission du formulaire de création', async () => {
    const brand = makeBrand({ name: 'LG' });
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    mockApi.post.mockResolvedValue(brand);
    renderPage();

    await waitFor(() => screen.getByTestId('add-brand'));
    await userEvent.click(screen.getByTestId('add-brand'));

    const nameInput = screen.getByLabelText(/nom/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'LG');

    const submitBtn = screen.getByRole('button', { name: /enregistrer/i });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/catalog/brands',
        expect.objectContaining({ name: 'LG' }),
      );
    });
  });

  it('affiche le tooltip upload prochainement sur le champ image', async () => {
    mockApi.get.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
    renderPage();
    await waitFor(() => screen.getByTestId('add-brand'));
    await userEvent.click(screen.getByTestId('add-brand'));

    expect(screen.getByText(/upload de fichier sera disponible prochainement/i)).toBeInTheDocument();
  });
});
