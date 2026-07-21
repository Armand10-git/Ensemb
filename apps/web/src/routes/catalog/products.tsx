import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import JsBarcode from 'jsbarcode';
import { api } from '../../lib/api';

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

function formatXAF(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-CM', { style: 'currency', currency: 'XAF', maximumFractionDigits: 0 }).format(n);
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── Barcode SVG ─────────────────────────────────────────────────────────────

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
        lineColor: '#93c5fd',
        fontOptions: '',
        fontSize: 10,
      });
    } catch {
      // format invalide ou valeur incorrecte — silencieux
    }
  }, [value, format]);
  if (!value) return null;
  return (
    <div className="mt-2 flex justify-center rounded-lg border border-white/10 bg-white/5 p-3">
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

// ─── Composants réutilisables ─────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse" aria-busy="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 rounded bg-white/10" />
        </td>
      ))}
    </tr>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/20 text-slate-400'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-slate-400'}`} />
      {active ? 'Actif' : 'Inactif'}
    </span>
  );
}

function CodeBadge({ code }: { code: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-blue-500/20 px-2 py-0.5 font-mono text-xs font-medium text-blue-300">
      {code}
    </span>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className="h-10 w-10 rounded-lg object-cover ring-1 ring-white/10"
      />
    );
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/30 to-indigo-600/30 text-xs font-bold text-blue-300 ring-1 ring-white/10">
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
    unitId: p.unit?.id ?? '',
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

function ProductSheet({
  open,
  onClose,
  initial,
  categories,
  brands,
  onSubmit,
  isPending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Product | null;
  categories: CategoryRef[];
  brands: BrandRef[];
  onSubmit: (data: ProductFormData) => void;
  isPending: boolean;
  error: string | null;
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

  if (!open) return null;

  const isEdit = !!initial;
  const inputCls =
    'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50';
  const labelCls = 'block text-xs font-medium uppercase tracking-wide text-slate-400 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Modifier le produit' : 'Nouveau produit'}
        className="relative ml-auto flex h-full w-full max-w-xl flex-col overflow-y-auto bg-[#0f1535] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <h2 className="text-lg font-semibold text-white">
            {isEdit ? 'Modifier le produit' : 'Nouveau produit'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        {/* Corps */}
        <form
          onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
          className="flex flex-1 flex-col gap-5 px-6 py-6"
        >
          {/* Code + Nom */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="p-code">Code *</label>
              <input
                id="p-code"
                type="text"
                required
                maxLength={50}
                placeholder="REF-001"
                className={inputCls}
                value={form.code}
                onChange={(e) => set('code', e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-barcode-type">Type code-barres</label>
              <select
                id="p-barcode-type"
                className={inputCls}
                value={form.barcodeType}
                onChange={(e) => set('barcodeType', e.target.value)}
              >
                <option value="">— Aucun —</option>
                {['EAN13', 'EAN8', 'CODE128', 'CODE39', 'QR'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Aperçu code-barres */}
          {form.barcodeType && form.code && (
            <BarcodePreview value={form.code} format={form.barcodeType} />
          )}

          <div>
            <label className={labelCls} htmlFor="p-name">Nom *</label>
            <input
              id="p-name"
              type="text"
              required
              maxLength={255}
              placeholder="Nom du produit"
              className={inputCls}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>

          {/* Prix */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="p-cost">Prix d'achat (XAF) *</label>
              <input
                id="p-cost"
                type="text"
                required
                placeholder="1500"
                pattern="^\d+(\.\d{1,3})?$"
                className={inputCls}
                value={form.cost}
                onChange={(e) => set('cost', e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-price">Prix de vente (XAF) *</label>
              <input
                id="p-price"
                type="text"
                required
                placeholder="2000"
                pattern="^\d+(\.\d{1,3})?$"
                className={inputCls}
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
              />
            </div>
          </div>

          {/* TVA */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="p-taxrate">Taux TVA</label>
              <input
                id="p-taxrate"
                type="text"
                placeholder="0.1925"
                className={inputCls}
                value={form.taxRate}
                onChange={(e) => set('taxRate', e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-500">ex. 0.1925 = 19,25 %</p>
            </div>
            <div>
              <label className={labelCls} htmlFor="p-taxmethod">Méthode TVA</label>
              <select
                id="p-taxmethod"
                className={inputCls}
                value={form.taxMethod}
                onChange={(e) => set('taxMethod', e.target.value as 'percentage' | 'fixed')}
              >
                <option value="percentage">Pourcentage</option>
                <option value="fixed">Montant fixe</option>
              </select>
            </div>
          </div>

          {/* Catégorie + Marque */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls} htmlFor="p-cat">Catégorie *</label>
              <select
                id="p-cat"
                required
                className={inputCls}
                value={form.categoryId}
                onChange={(e) => set('categoryId', e.target.value)}
              >
                <option value="">— Choisir —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="p-brand">Marque</label>
              <select
                id="p-brand"
                className={inputCls}
                value={form.brandId}
                onChange={(e) => set('brandId', e.target.value)}
              >
                <option value="">— Aucune —</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Alerte stock */}
          <div>
            <label className={labelCls} htmlFor="p-alert">Seuil d'alerte stock</label>
            <input
              id="p-alert"
              type="number"
              min={0}
              className={inputCls}
              value={form.stockAlert}
              onChange={(e) => set('stockAlert', parseInt(e.target.value) || 0)}
            />
          </div>

          {/* Note */}
          <div>
            <label className={labelCls} htmlFor="p-note">Note</label>
            <textarea
              id="p-note"
              rows={2}
              maxLength={1000}
              className={`${inputCls} resize-none`}
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
            />
          </div>

          {/* Switch variantes */}
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-white">Produit à variantes</p>
              <p className="text-xs text-slate-400">Tailles, couleurs, conditionnements…</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.isVariant}
              data-testid="variant-switch"
              onClick={() => set('isVariant', !form.isVariant)}
              className={`relative h-6 w-11 rounded-full transition-colors focus:outline-none ${
                form.isVariant ? 'bg-blue-500' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  form.isVariant ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Section variantes */}
          {form.isVariant && (
            <div
              className="space-y-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4"
              data-testid="variants-section"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-400">Variantes</p>
              {form.variantNames.map((name, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    placeholder={`Variante ${i + 1}`}
                    maxLength={100}
                    className={`${inputCls} flex-1`}
                    value={name}
                    onChange={(e) => updateVariant(i, e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeVariant(i)}
                    className="rounded-lg px-2 text-red-400 hover:bg-red-500/10"
                    aria-label={`Supprimer variante ${i + 1}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addVariant}
                className="text-xs font-medium text-blue-400 hover:text-blue-300"
              >
                + Ajouter une variante
              </button>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="mt-auto flex justify-end gap-3 border-t border-white/10 pt-5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {isPending ? 'Enregistrement…' : isEdit ? 'Modifier' : 'Créer'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

// ─── AlertDialog suppression ──────────────────────────────────────────────────

function DeleteDialog({
  open,
  product,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  open: boolean;
  product: Product | null;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: string | null;
}) {
  if (!open || !product) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirmer la suppression"
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1535] p-6 shadow-2xl">
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/20">
          <span className="text-xl text-red-400">🗑</span>
        </div>
        <h3 className="mb-2 mt-3 text-lg font-semibold text-white">Supprimer le produit</h3>
        <p className="mb-5 text-sm text-slate-400">
          Voulez-vous vraiment supprimer{' '}
          <span className="font-semibold text-white">
            {product.code} — {product.name}
          </span>{' '}
          ? Cette action ne peut pas être annulée.
        </p>
        {error && (
          <p role="alert" className="mb-4 text-sm text-red-400">{error}</p>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
          >
            Annuler
          </button>
          <button
            data-testid="confirm-delete"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {isPending ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </div>
    </div>
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

  return (
    <div className="min-h-screen bg-[#0b1437] p-6 text-white">
      {/* Hidden file input pour upload image */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={handleFileChange}
      />

      {/* En-tête */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500">Catalogue</p>
          <h1 className="text-2xl font-bold text-white">Produits</h1>
          {data && (
            <p className="mt-0.5 text-sm text-slate-400">
              {data.total} produit{data.total !== 1 ? 's' : ''} au total
            </p>
          )}
        </div>
        <button
          data-testid="add-product"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-500 transition-colors"
        >
          <span>+</span> Nouveau produit
        </button>
      </div>

      {/* Filtres */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <input
          type="search"
          placeholder="Rechercher par code ou nom…"
          aria-label="Rechercher un produit"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/50 sm:w-64"
        />
        <select
          aria-label="Filtrer par catégorie"
          value={catFilter}
          onChange={(e) => { setCatFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white focus:border-blue-500/50 focus:outline-none"
        >
          <option value="">Toutes les catégories</option>
          {catList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          aria-label="Filtrer par marque"
          value={brandFilter}
          onChange={(e) => { setBrandFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white focus:border-blue-500/50 focus:outline-none"
        >
          <option value="">Toutes les marques</option>
          {brandList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {/* État erreur */}
      {isError && (
        <div
          role="alert"
          className="mb-5 flex items-center justify-between rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-red-400"
        >
          <span>{(error as Error)?.message ?? 'Impossible de charger les produits.'}</span>
          <button
            onClick={() => void refetch()}
            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm font-medium hover:bg-red-500/30"
          >
            Réessayer
          </button>
        </div>
      )}

      {/* Carte tableau */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#111c44]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {['Image', 'Code', 'Nom', 'Catégorie', 'Prix vente', 'Stock', 'Statut', 'Actions'].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {/* Chargement */}
              {isLoading && [1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} cols={8} />)}

              {/* Données */}
              {!isLoading && !isError && data?.data.map((product) => (
                <tr
                  key={product.id}
                  className="group transition-colors hover:bg-white/5"
                >
                  <td className="px-4 py-3">
                    <button
                      aria-label={`Changer l'image de ${product.name}`}
                      onClick={() => triggerImageUpload(product.id)}
                      className="block"
                    >
                      <Avatar src={product.imageUrl} name={product.name} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <CodeBadge code={product.code} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{product.name}</p>
                    {product.isVariant && (
                      <p className="text-xs text-slate-500">
                        {product.variants.length} variante{product.variants.length !== 1 ? 's' : ''}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400">
                    {product.category.name}
                  </td>
                  <td className="px-4 py-3 font-mono text-right text-slate-200 tabular-nums">
                    {formatXAF(product.price)}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    — {/* S15 */}
                  </td>
                  <td className="px-4 py-3">
                    <ActiveBadge active={product.isActive} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        aria-label={`Modifier ${product.name}`}
                        onClick={() => openEdit(product)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/10"
                      >
                        Modifier
                      </button>
                      <button
                        aria-label={`Supprimer ${product.name}`}
                        onClick={() => setDeleteTarget(product)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10"
                      >
                        Supprimer
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* État vide */}
        {!isLoading && !isError && data?.data.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10">
              <span className="text-3xl">📦</span>
            </div>
            <p className="text-base font-semibold text-white">Aucun produit</p>
            <p className="mt-1 text-sm text-slate-400">
              {debouncedSearch || catFilter || brandFilter
                ? 'Aucun produit ne correspond aux filtres.'
                : 'Créez votre premier produit pour commencer.'}
            </p>
            {!debouncedSearch && !catFilter && !brandFilter && (
              <button
                data-testid="empty-add-product"
                onClick={openCreate}
                className="mt-5 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
              >
                Nouveau produit
              </button>
            )}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-400">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-white/10 px-3 py-1.5 hover:bg-white/5 disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded-lg border border-white/10 px-3 py-1.5 hover:bg-white/5 disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}

      {/* Sheet créer/éditer */}
      <ProductSheet
        open={sheetOpen}
        onClose={closeSheet}
        initial={editTarget}
        categories={catList}
        brands={brandList}
        onSubmit={handleSubmit}
        isPending={isPendingForm}
        error={activeError ? (activeError as Error).message : null}
      />

      {/* AlertDialog suppression */}
      <DeleteDialog
        open={!!deleteTarget}
        product={deleteTarget}
        onCancel={() => { setDeleteTarget(null); deleteProduct.reset(); }}
        onConfirm={handleDelete}
        isPending={deleteProduct.isPending}
        error={deleteProduct.error ? (deleteProduct.error as Error).message : null}
      />
    </div>
  );
}

export default ProductsPage;
