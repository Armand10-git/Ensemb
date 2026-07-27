import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import { Plus, Trash2, Pencil, Package, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { cn, formatXAF } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { NativeSelect } from '../../components/ui/native-select';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../../components/ui/alert-dialog';
import { PageHeader, TableSkeleton, EmptyState, ErrorState } from '../../components/page-states';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProductVariant {
  id: string;
  name: string | null;
}

interface CategoryRef { id: string; code: string; name: string }
interface BrandRef    { id: string; name: string }
interface UnitRef     { id: string; name: string; shortName: string }

interface Product {
  id: string;
  code: string;
  barcodeType: string | null;
  name: string;
  cost: string;
  price: string;
  taxRate: string;
  taxMethod: string;
  image: string | null;
  imageUrl: string | null;
  note: string | null;
  stockAlert: number;
  isVariant: boolean;
  isActive: boolean;
  category: CategoryRef;
  brand: BrandRef | null;
  unit: UnitRef | null;
  variants: ProductVariant[];
  createdAt: string;
  updatedAt: string;
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface ProductFormData {
  code: string;
  name: string;
  barcodeType: string;
  cost: string;
  price: string;
  categoryId: string;
  brandId: string;
  unitId: string;
  unitSaleId: string;
  unitPurchaseId: string;
  taxRate: string;
  taxMethod: 'percentage' | 'fixed';
  note: string;
  stockAlert: number;
  isVariant: boolean;
  variantNames: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── Aperçu code-barres ────────────────────────────────────────────────────────

function BarcodePreview({ value, format }: { value: string; format: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try {
      JsBarcode(ref.current, value, {
        format: format || 'CODE128',
        width: 1.5,
        height: 50,
        displayValue: true,
        background: 'transparent',
        lineColor: '#1f2937',
        fontOptions: '',
        fontSize: 10,
      });
    } catch {
      // format invalide ou valeur incorrecte — silencieux
    }
  }, [value, format]);
  if (!value) return null;
  return (
    <div className="mt-1 flex justify-center rounded-card border border-neutral-200 bg-neutral-50 p-3">
      <svg ref={ref} />
    </div>
  );
}

// ─── API Hooks ────────────────────────────────────────────────────────────────

function useProducts(page: number, limit: number, search: string, categoryId: string, brandId: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (search)     params.set('search', search);
  if (categoryId) params.set('categoryId', categoryId);
  if (brandId)    params.set('brandId', brandId);
  return useQuery<Paginated<Product>>({
    queryKey: ['products', page, limit, search, categoryId, brandId],
    queryFn: () => api.get<Paginated<Product>>(`/catalog/products?${params.toString()}`),
  });
}

function useCategories() {
  return useQuery<Paginated<CategoryRef>>({
    queryKey: ['categories-all'],
    queryFn: () => api.get<Paginated<CategoryRef>>('/catalog/categories?limit=200'),
    staleTime: 60_000,
  });
}

function useBrands() {
  return useQuery<Paginated<BrandRef>>({
    queryKey: ['brands-all'],
    queryFn: () => api.get<Paginated<BrandRef>>('/catalog/brands?limit=200'),
    staleTime: 60_000,
  });
}

function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Product>('/catalog/products', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['products'] }); },
  });
}

function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: unknown }) =>
      api.patch<Product>(`/catalog/products/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['products'] }); },
  });
}

function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/products/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['products'] }); },
  });
}

function useUploadImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<{ imageUrl: string }>(`/catalog/products/${id}/image`, fd);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['products'] }); },
  });
}

// ─── Stock lazy par produit (S15) ─────────────────────────────────────────────

interface StockEntry {
  id: string;
  warehouseName: string;
  quantity: string;
}

interface StockSummary {
  productId: string;
  /** Total calculé côté serveur en Decimal — affiché directement, jamais recalculé en JS. */
  totalQuantity: string;
  byWarehouse: StockEntry[];
}

function useProductStockSummary(productId: string, enabled: boolean) {
  return useQuery<StockSummary>({
    queryKey: ['product-stock-summary', productId],
    queryFn: () => api.get<StockSummary>(`/inventory/stock/summary/${productId}`),
    enabled,
    staleTime: 30_000,
  });
}

function StockPopover({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, isLoading, isError } = useProductStockSummary(productId, open);

  // Fermer au clic extérieur
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-field px-2 py-0.5 text-[12.5px] font-medium text-neutral-600 hover:bg-neutral-100 focus:outline-none"
        aria-label="Voir le stock par entrepôt"
      >
        {data
          ? <span className="tabular">{parseFloat(data.totalQuantity).toLocaleString('fr-CM', { maximumFractionDigits: 3 })}</span>
          : <span className="text-neutral-400">Stock</span>}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[200px] rounded-card border border-neutral-200 bg-white p-3 shadow-2">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Stock par entrepôt
          </p>
          {isLoading && (
            <div className="space-y-1.5">
              {[1, 2].map((i) => <Skeleton key={i} className="h-3 w-full" />)}
            </div>
          )}
          {isError && (
            <p className="text-[12.5px] text-danger-600">Erreur de chargement.</p>
          )}
          {!isLoading && !isError && data && data.byWarehouse.length === 0 && (
            <p className="text-[12.5px] text-neutral-400">Aucun stock initialisé.</p>
          )}
          {!isLoading && !isError && data && data.byWarehouse.length > 0 && (
            <ul className="space-y-1">
              {data.byWarehouse.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4">
                  <span className="truncate text-[12.5px] text-neutral-600">{e.warehouseName}</span>
                  <span className="tabular text-[12.5px] font-medium text-neutral-900">
                    {parseFloat(e.quantity).toLocaleString('fr-CM', { maximumFractionDigits: 3 })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Composants réutilisables ─────────────────────────────────────────────────

function ActiveBadge({ active }: { active: boolean }) {
  return <Badge variant={active ? 'success' : 'neutral'}>{active ? 'Actif' : 'Inactif'}</Badge>;
}

function CodeBadge({ code }: { code: string }) {
  return <Badge variant="info" className="tabular font-mono">{code}</Badge>;
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className="h-10 w-10 rounded-card border border-neutral-200 object-cover"
      />
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-card border border-neutral-200 bg-brand-50 text-[13px] font-semibold text-brand-600">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Formulaire produit (dans un Sheet) ──────────────────────────────────────

const DEFAULT_FORM: ProductFormData = {
  code: '',
  name: '',
  barcodeType: '',
  cost: '',
  price: '',
  categoryId: '',
  brandId: '',
  unitId: '',
  unitSaleId: '',
  unitPurchaseId: '',
  taxRate: '0',
  taxMethod: 'percentage',
  note: '',
  stockAlert: 0,
  isVariant: false,
  variantNames: [],
};

function productToForm(p: Product): ProductFormData {
  return {
    code: p.code,
    name: p.name,
    barcodeType: p.barcodeType ?? '',
    cost: p.cost,
    price: p.price,
    categoryId: p.category.id,
    brandId: p.brand?.id ?? '',
    unitId: '',
    unitSaleId: '',
    unitPurchaseId: '',
    taxRate: p.taxRate,
    taxMethod: p.taxMethod as 'percentage' | 'fixed',
    note: p.note ?? '',
    stockAlert: p.stockAlert,
    isVariant: p.isVariant,
    variantNames: p.variants.map((v) => v.name ?? ''),
  };
}

function ProductForm({
  open,
  initial,
  categories,
  brands,
  onSubmit,
  isPending,
  error,
  onCancel,
}: {
  open: boolean;
  initial?: Product | null;
  categories: CategoryRef[];
  brands: BrandRef[];
  onSubmit: (data: ProductFormData) => void;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ProductFormData>(DEFAULT_FORM);

  useEffect(() => {
    if (open) {
      setForm(initial ? productToForm(initial) : DEFAULT_FORM);
    }
  }, [open, initial]);

  const set = useCallback(<K extends keyof ProductFormData>(key: K, val: ProductFormData[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  }, []);

  function addVariant() {
    setForm((f) => ({ ...f, variantNames: [...f.variantNames, ''] }));
  }

  function updateVariant(i: number, val: string) {
    setForm((f) => {
      const arr = [...f.variantNames];
      arr[i] = val;
      return { ...f, variantNames: arr };
    });
  }

  function removeVariant(i: number) {
    setForm((f) => ({ ...f, variantNames: f.variantNames.filter((_, idx) => idx !== i) }));
  }

  const isEdit = !!initial;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
      className="flex flex-1 flex-col gap-5 px-6 py-6"
    >
      {/* Code + Type code-barres */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-code">Code *</Label>
          <Input
            id="p-code"
            type="text"
            required
            maxLength={50}
            placeholder="REF-001"
            value={form.code}
            onChange={(e) => set('code', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-barcode-type">Type code-barres</Label>
          <NativeSelect
            id="p-barcode-type"
            value={form.barcodeType}
            onChange={(e) => set('barcodeType', e.target.value)}
          >
            <option value="">— Aucun —</option>
            {['EAN13', 'EAN8', 'CODE128', 'CODE39', 'QR'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {/* Aperçu code-barres */}
      {form.barcodeType && form.code && (
        <BarcodePreview value={form.code} format={form.barcodeType} />
      )}

      <div className="space-y-1.5">
        <Label htmlFor="p-name">Nom *</Label>
        <Input
          id="p-name"
          type="text"
          required
          maxLength={255}
          placeholder="Nom du produit"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </div>

      {/* Prix */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-cost">Prix d'achat (XAF) *</Label>
          <Input
            id="p-cost"
            type="text"
            required
            placeholder="1500"
            pattern="^\d+(\.\d{1,3})?$"
            value={form.cost}
            onChange={(e) => set('cost', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-price">Prix de vente (XAF) *</Label>
          <Input
            id="p-price"
            type="text"
            required
            placeholder="2000"
            pattern="^\d+(\.\d{1,3})?$"
            value={form.price}
            onChange={(e) => set('price', e.target.value)}
          />
        </div>
      </div>

      {/* TVA */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-taxrate">Taux TVA</Label>
          <Input
            id="p-taxrate"
            type="text"
            placeholder="0.1925"
            value={form.taxRate}
            onChange={(e) => set('taxRate', e.target.value)}
          />
          <p className="text-[11.5px] text-neutral-500">ex. 0.1925 = 19,25 %</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-taxmethod">Méthode TVA</Label>
          <NativeSelect
            id="p-taxmethod"
            value={form.taxMethod}
            onChange={(e) => set('taxMethod', e.target.value as 'percentage' | 'fixed')}
          >
            <option value="percentage">Pourcentage</option>
            <option value="fixed">Montant fixe</option>
          </NativeSelect>
        </div>
      </div>

      {/* Catégorie + Marque */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="p-cat">Catégorie *</Label>
          <NativeSelect
            id="p-cat"
            required
            value={form.categoryId}
            onChange={(e) => set('categoryId', e.target.value)}
          >
            <option value="">— Choisir —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="p-brand">Marque</Label>
          <NativeSelect
            id="p-brand"
            value={form.brandId}
            onChange={(e) => set('brandId', e.target.value)}
          >
            <option value="">— Aucune —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {/* Alerte stock */}
      <div className="space-y-1.5">
        <Label htmlFor="p-alert">Seuil d'alerte stock</Label>
        <Input
          id="p-alert"
          type="number"
          min={0}
          value={form.stockAlert}
          onChange={(e) => set('stockAlert', parseInt(e.target.value) || 0)}
        />
      </div>

      {/* Note */}
      <div className="space-y-1.5">
        <Label htmlFor="p-note">Note</Label>
        <Textarea
          id="p-note"
          rows={2}
          maxLength={1000}
          value={form.note}
          onChange={(e) => set('note', e.target.value)}
        />
      </div>

      {/* Switch variantes */}
      <div className="flex items-center justify-between rounded-card border border-neutral-200 bg-neutral-50 px-4 py-3">
        <div>
          <p className="text-[13.5px] font-medium text-neutral-900">Produit à variantes</p>
          <p className="text-[12px] text-neutral-500">Tailles, couleurs, conditionnements…</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.isVariant}
          data-testid="variant-switch"
          onClick={() => set('isVariant', !form.isVariant)}
          className={cn(
            'relative h-6 w-11 rounded-full transition-colors focus:outline-none',
            form.isVariant ? 'bg-brand-500' : 'bg-neutral-300',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-1 transition-transform',
              form.isVariant ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>

      {/* Section variantes */}
      {form.isVariant && (
        <div
          className="space-y-2.5 rounded-card border border-brand-200 bg-brand-50 p-4"
          data-testid="variants-section"
        >
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-brand-700">Variantes</p>
          {form.variantNames.map((name, i) => (
            <div key={i} className="flex gap-2">
              <Input
                type="text"
                placeholder={`Variante ${i + 1}`}
                maxLength={100}
                className="flex-1"
                value={name}
                onChange={(e) => updateVariant(i, e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => removeVariant(i)}
                aria-label={`Supprimer variante ${i + 1}`}
                className="text-danger-600 hover:bg-danger-50"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" type="button" onClick={addVariant}>
            <Plus className="h-3.5 w-3.5" />
            Ajouter une variante
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-card border border-danger-200 bg-danger-50 px-4 py-3 text-[13px] text-danger-700">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="mt-auto flex justify-end gap-2.5 border-t border-neutral-100 pt-5">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Annuler
        </Button>
        <Button type="submit" loading={isPending}>
          {!isPending && (isEdit ? 'Modifier' : 'Créer')}
          {isPending && 'Enregistrement…'}
        </Button>
      </div>
    </form>
  );
}

// ─── Écran principal ──────────────────────────────────────────────────────────

export function ProductsPage() {
  const [page, setPage]           = useState(1);
  const limit                      = 20;
  const [search, setSearch]       = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');

  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, isError, error, refetch } = useProducts(
    page, limit, debouncedSearch, catFilter, brandFilter,
  );
  const categories = useCategories();
  const brands     = useBrands();

  const createProduct  = useCreateProduct();
  const updateProduct  = useUpdateProduct();
  const deleteProduct  = useDeleteProduct();
  const uploadImage    = useUploadImage();

  const [sheetOpen,   setSheetOpen]   = useState(false);
  const [editTarget,  setEditTarget]  = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  // Image upload déclenché depuis la table
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTargetId, setUploadTargetId] = useState<string | null>(null);

  function openCreate() { setEditTarget(null); setSheetOpen(true); }
  function openEdit(p: Product) { setEditTarget(p); setSheetOpen(true); }
  function closeSheet() {
    setSheetOpen(false);
    setEditTarget(null);
    createProduct.reset();
    updateProduct.reset();
  }

  function handleSubmit(form: ProductFormData) {
    const payload = {
      code: form.code,
      name: form.name,
      barcodeType: form.barcodeType || undefined,
      cost: form.cost,
      price: form.price,
      categoryId: form.categoryId,
      brandId: form.brandId || undefined,
      unitId: form.unitId || undefined,
      unitSaleId: form.unitSaleId || undefined,
      unitPurchaseId: form.unitPurchaseId || undefined,
      taxRate: form.taxRate || undefined,
      taxMethod: form.taxMethod,
      note: form.note || undefined,
      stockAlert: form.stockAlert,
      isVariant: form.isVariant,
      variants: form.isVariant
        ? form.variantNames.filter(Boolean).map((n) => ({ name: n }))
        : undefined,
    };

    if (editTarget) {
      updateProduct.mutate(
        { id: editTarget.id, data: payload },
        { onSuccess: closeSheet },
      );
    } else {
      createProduct.mutate(payload, { onSuccess: closeSheet });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteProduct.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  function triggerImageUpload(productId: string) {
    setUploadTargetId(productId);
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !uploadTargetId) return;
    uploadImage.mutate({ id: uploadTargetId, file });
    e.target.value = '';
  }

  const activeError = editTarget ? updateProduct.error : createProduct.error;
  const isPendingForm = editTarget ? updateProduct.isPending : createProduct.isPending;

  const catList   = useMemo(() => categories.data?.data ?? [], [categories.data]);
  const brandList = useMemo(() => brands.data?.data ?? [], [brands.data]);

  const rows = data?.data ?? [];

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      {/* Hidden file input pour upload image */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={handleFileChange}
      />

      <PageHeader
        title="Produits"
        description={data ? `${data.total} produit${data.total !== 1 ? 's' : ''} au total` : 'Catalogue, code-barres et variantes.'}
        action={
          <Button data-testid="add-product" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouveau produit
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <Input
            type="search"
            placeholder="Rechercher par code ou nom…"
            aria-label="Rechercher un produit"
            className="w-64"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
          <NativeSelect
            className="w-auto min-w-[10rem]"
            aria-label="Filtrer par catégorie"
            value={catFilter}
            onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
          >
            <option value="">Toutes les catégories</option>
            {catList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[10rem]"
            aria-label="Filtrer par marque"
            value={brandFilter}
            onChange={(e) => { setBrandFilter(e.target.value); setPage(1); }}
          >
            <option value="">Toutes les marques</option>
            {brandList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={8} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error)?.message ?? 'Impossible de charger les produits.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Package}
          title="Aucun produit"
          description={
            debouncedSearch || catFilter || brandFilter
              ? 'Aucun produit ne correspond aux filtres.'
              : 'Créez votre premier produit pour commencer.'
          }
          action={
            !debouncedSearch && !catFilter && !brandFilter && (
              <Button data-testid="empty-add-product" onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Nouveau produit
              </Button>
            )
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Image</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead>Catégorie</TableHead>
              <TableHead className="text-right">Prix vente</TableHead>
              <TableHead>Stock</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((product) => (
              <TableRow key={product.id}>
                <TableCell>
                  <button
                    aria-label={`Changer l'image de ${product.name}`}
                    onClick={() => triggerImageUpload(product.id)}
                    className="block"
                  >
                    <Avatar src={product.imageUrl} name={product.name} />
                  </button>
                </TableCell>
                <TableCell>
                  <CodeBadge code={product.code} />
                </TableCell>
                <TableCell>
                  <p className="font-medium text-neutral-900">{product.name}</p>
                  {product.isVariant && (
                    <p className="text-[12px] text-neutral-500">
                      {product.variants.length} variante{product.variants.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-neutral-600">{product.category.name}</TableCell>
                <TableCell className="tabular text-right">{formatXAF(product.price)}</TableCell>
                <TableCell>
                  <StockPopover productId={product.id} />
                </TableCell>
                <TableCell>
                  <ActiveBadge active={product.isActive} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${product.name}`}
                      onClick={() => openEdit(product)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${product.name}`}
                      onClick={() => setDeleteTarget(product)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {!isLoading && !isError && totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button variant="secondary" size="icon" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-[13px] text-neutral-500">{page} / {totalPages}</span>
          <Button variant="secondary" size="icon" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* ── Sheet créer/éditer ───────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={(open) => { if (!open) closeSheet(); }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editTarget ? 'Modifier le produit' : 'Nouveau produit'}</SheetTitle>
            <SheetDescription>Code, prix, catégorie et variantes éventuelles.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <ProductForm
              open={sheetOpen}
              initial={editTarget}
              categories={catList}
              brands={brandList}
              onSubmit={handleSubmit}
              isPending={isPendingForm}
              error={activeError ? (activeError as Error).message : null}
              onCancel={closeSheet}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) { setDeleteTarget(null); deleteProduct.reset(); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer le produit {deleteTarget?.code} — {deleteTarget?.name} ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cette action ne peut pas être annulée. Le produit sera définitivement supprimé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteProduct.error && (
            <p role="alert" className="text-[13px] text-danger-600">
              {(deleteProduct.error as Error).message}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteProduct.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete"
              disabled={deleteProduct.isPending}
              onClick={handleDelete}
            >
              {deleteProduct.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ProductsPage;
