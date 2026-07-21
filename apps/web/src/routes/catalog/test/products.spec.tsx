import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProductsPage } from '../products';

// ─── Mock jsbarcode (SVG non rendu en jsdom) ──────────────────────────────────

vi.mock('jsbarcode', () => ({ default: vi.fn() }));

// ─── Mock API ────────────────────────────────────────────────────────────────

vi.mock('../../../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}));

import { api } from '../../../lib/api';
const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePaginatedProduct(overrides: Partial<{
  id: string; code: string; name: string; barcodeType: string | null;
  image: string | null; imageUrl: string | null; isVariant: boolean; variants: unknown[];
}> = {}) {
  return {
    data: [{
      id: 'prod-1',
      code: 'REF-001',
      barcodeType: null,
      name: 'Produit Test',
      cost: '1000',
      price: '1500',
      taxRate: '0.1925',
      taxMethod: 'percentage',
      image: null,
      imageUrl: null,
      note: null,
      stockAlert: 0,
      isVariant: false,
      isActive: true,
      category: { id: 'cat-1', code: 'TST', name: 'Test Cat' },
      brand: null,
      unit: null,
      variants: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      ...overrides,
    }],
    total: 1,
    page: 1,
    limit: 20,
  };
}

const emptyResponse = { data: [], total: 0, page: 1, limit: 20 };
const catResponse   = { data: [{ id: 'cat-1', code: 'TST', name: 'Test Cat' }], total: 1, page: 1, limit: 200 };
const brandResponse = { data: [], total: 0, page: 1, limit: 200 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProductsPage />
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProductsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Par défaut : liste de produits normale
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/catalog/categories')) return Promise.resolve(catResponse);
      if (path.includes('/catalog/brands'))     return Promise.resolve(brandResponse);
      return Promise.resolve(makePaginatedProduct());
    });
  });

  // ── État chargement ──────────────────────────────────────────────────────

  it("affiche des skeletons pendant le chargement", () => {
    // get ne résout jamais → état chargement permanent
    mockApi.get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  // ── État succès ───────────────────────────────────────────────────────────

  it("affiche le produit après chargement réussi", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Produit Test')).toBeInTheDocument());
    expect(screen.getByText('REF-001')).toBeInTheDocument();
    // "Test Cat" apparaît dans la cellule du tableau (getAllByText car aussi dans le <option>)
    const cells = screen.getAllByText('Test Cat');
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });

  // ── État vide ─────────────────────────────────────────────────────────────

  it("affiche l'état vide si aucun produit", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/catalog/categories')) return Promise.resolve(catResponse);
      if (path.includes('/catalog/brands'))     return Promise.resolve(brandResponse);
      return Promise.resolve(emptyResponse);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Aucun produit')).toBeInTheDocument());
    expect(screen.getByTestId('empty-add-product')).toBeInTheDocument();
  });

  // ── État erreur ───────────────────────────────────────────────────────────

  it("affiche le bouton Réessayer en cas d'erreur", async () => {
    mockApi.get.mockRejectedValue(new Error('Erreur réseau'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Réessayer')).toBeInTheDocument());
  });

  // ── Code-barres ───────────────────────────────────────────────────────────

  it("affiche l'aperçu code-barres dans le formulaire si barcodeType renseigné", async () => {
    const JsBarcodeMock = (await import('jsbarcode')).default as ReturnType<typeof vi.fn>;

    renderPage();
    await waitFor(() => expect(screen.getByTestId('add-product')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('add-product'));

    // Renseigner le code et le type de code-barres
    const codeInput = screen.getByLabelText(/^Code/i);
    const barcodeSelect = screen.getByLabelText(/type code-barres/i);

    await userEvent.type(codeInput, 'REF-TEST');
    await userEvent.selectOptions(barcodeSelect, 'CODE128');

    // L'aperçu SVG doit être présent dans le DOM
    await waitFor(() => {
      const svgs = document.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThan(0);
    });

    // JsBarcode doit avoir été appelé avec la valeur et le format
    await waitFor(() => {
      expect(JsBarcodeMock).toHaveBeenCalled();
    });
  });

  // ── Section variantes ─────────────────────────────────────────────────────

  it("affiche la section variantes lorsque le switch est activé", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('add-product')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('add-product'));

    const switchBtn = screen.getByTestId('variant-switch');
    expect(screen.queryByTestId('variants-section')).toBeNull();

    await userEvent.click(switchBtn);

    expect(screen.getByTestId('variants-section')).toBeInTheDocument();
  });

  // ── imageUrl avatar ───────────────────────────────────────────────────────

  it("affiche l'image signée dans l'avatar si imageUrl est présent", async () => {
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/catalog/categories')) return Promise.resolve(catResponse);
      if (path.includes('/catalog/brands'))     return Promise.resolve(brandResponse);
      return Promise.resolve(
        makePaginatedProduct({ imageUrl: 'https://s3.example.com/signed-url', image: 'org/products/img.jpg' }),
      );
    });
    renderPage();
    await waitFor(() => {
      const img = document.querySelector('img[alt="Produit Test"]') as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img?.src).toBe('https://s3.example.com/signed-url');
    });
  });

  // ── AlertDialog suppression ───────────────────────────────────────────────

  it("l'AlertDialog nomme le produit avant suppression", async () => {
    mockApi.delete.mockResolvedValue(undefined);
    mockApi.get.mockImplementation((path: string) => {
      if (path.includes('/catalog/categories')) return Promise.resolve(catResponse);
      if (path.includes('/catalog/brands'))     return Promise.resolve(brandResponse);
      return Promise.resolve(makePaginatedProduct());
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Produit Test')).toBeInTheDocument());

    // Survol pour afficher les boutons
    const row = screen.getByText('Produit Test').closest('tr')!;
    fireEvent.mouseEnter(row);

    const deleteBtn = screen.getByLabelText('Supprimer Produit Test');
    await userEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
    // Vérifier le contenu de l'AlertDialog (code + nom du produit)
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toMatch(/REF-001/);
    expect(dialog.textContent).toMatch(/Produit Test/);
    expect(screen.getByTestId('confirm-delete')).toBeInTheDocument();
  });
});
