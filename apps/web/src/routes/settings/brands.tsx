import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Brand {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedBrands {
  data: Brand[];
  total: number;
  page: number;
  limit: number;
}

interface BrandFormData {
  name: string;
  description: string;
  image: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useBrands(page: number, limit = 20) {
  return useQuery<PaginatedBrands>({
    queryKey: ['brands', page, limit],
    queryFn: () => api.get<PaginatedBrands>(`/catalog/brands?page=${page}&limit=${limit}`),
  });
}

function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BrandFormData>) => api.post<Brand>('/catalog/brands', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

function useUpdateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<BrandFormData> }) =>
      api.patch<Brand>(`/catalog/brands/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

function useDeleteBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/brands/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['brands'] }); },
  });
}

// ─── Composants ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse" aria-busy="true">
      {[1, 2, 3, 4].map((i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 bg-gray-200 rounded w-full" />
        </td>
      ))}
    </tr>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800"
    >
      <span>{message}</span>
      <button
        onClick={onRetry}
        className="ml-4 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
      >
        Réessayer
      </button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-500">
      <p className="text-lg font-medium">Aucune marque</p>
      <p className="mt-1 text-sm">Créez votre première marque pour enrichir votre catalogue.</p>
      <button
        data-testid="empty-add-brand"
        onClick={onAdd}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Nouvelle marque
      </button>
    </div>
  );
}

function BrandAvatar({ name, image }: { name: string; image: string | null }) {
  if (image) {
    return (
      <img
        src={image}
        alt={`Logo ${name}`}
        className="h-8 w-8 rounded-full object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
          (e.currentTarget.nextSibling as HTMLElement | null)?.removeAttribute('hidden');
        }}
      />
    );
  }
  return (
    <div
      aria-label={`Initiale ${name}`}
      className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function BrandDialog({
  open,
  onClose,
  initial,
  onSubmit,
  isPending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<BrandFormData>;
  onSubmit: (data: Partial<BrandFormData>) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<BrandFormData>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    image: initial?.image ?? '',
  });

  React.useEffect(() => {
    if (open) {
      setForm({
        name: initial?.name ?? '',
        description: initial?.description ?? '',
        image: initial?.image ?? '',
      });
    }
  }, [open, initial?.name, initial?.description, initial?.image]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: Partial<BrandFormData> = { name: form.name };
    if (form.description.trim()) payload.description = form.description;
    if (form.image.trim()) payload.image = form.image;
    onSubmit(payload);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={initial?.name ? 'Modifier la marque' : 'Nouvelle marque'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {initial?.name ? 'Modifier la marque' : 'Nouvelle marque'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="brand-name">
              Nom <span className="text-red-500">*</span>
            </label>
            <input
              id="brand-name"
              type="text"
              required
              maxLength={100}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="brand-description">
              Description
            </label>
            <textarea
              id="brand-description"
              maxLength={500}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="brand-image">
              URL du logo
              <span
                title="L'upload de fichier sera disponible prochainement"
                className="ml-1 cursor-help text-gray-400"
              >
                ⓘ
              </span>
            </label>
            <input
              id="brand-image"
              type="url"
              maxLength={2048}
              placeholder="https://exemple.com/logo.png"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.image}
              onChange={(e) => setForm((f) => ({ ...f, image: e.target.value }))}
            />
            <p className="mt-1 text-xs text-gray-400">L'upload de fichier sera disponible prochainement</p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteDialog({
  open,
  brandName,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  open: boolean;
  brandName: string;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: string | null;
}) {
  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirmer la suppression"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Supprimer la marque</h2>
        <p className="mb-4 text-sm text-gray-600">
          Voulez-vous vraiment supprimer la marque{' '}
          <span className="font-semibold text-gray-900">"{brandName}"</span> ?
          Cette action ne peut pas être annulée.
        </p>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Annuler
          </button>
          <button
            data-testid="confirm-delete"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-md bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Écran principal ─────────────────────────────────────────────────────────

export function BrandsPage() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, isError, error, refetch } = useBrands(page, limit);
  const createBrand = useCreateBrand();
  const updateBrand = useUpdateBrand();
  const deleteBrand = useDeleteBrand();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Brand | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(brand: Brand) {
    setEditTarget(brand);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createBrand.reset();
    updateBrand.reset();
  }

  function handleSubmit(formData: Partial<BrandFormData>) {
    if (editTarget) {
      updateBrand.mutate(
        { id: editTarget.id, data: formData },
        { onSuccess: closeDialog },
      );
    } else {
      createBrand.mutate(formData, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteBrand.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const activeError = editTarget ? updateBrand.error : createBrand.error;
  const isPendingForm = editTarget ? updateBrand.isPending : createBrand.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Marques</h1>
        <button
          data-testid="add-brand"
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Nouvelle marque
        </button>
      </div>

      {/* État erreur */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Impossible de charger les marques.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* Tableau */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Logo', 'Nom', 'Description', 'Actions'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {/* État chargement */}
            {isLoading && [1, 2, 3].map((i) => <SkeletonRow key={i} />)}

            {/* État succès */}
            {!isLoading && !isError && data?.data.map((brand) => (
              <tr key={brand.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <BrandAvatar name={brand.name} image={brand.image} />
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{brand.name}</td>
                <td className="px-4 py-3 max-w-xs text-gray-500 truncate">
                  {brand.description ?? '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      aria-label={`Modifier ${brand.name}`}
                      onClick={() => openEdit(brand)}
                      className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                    >
                      Modifier
                    </button>
                    <button
                      aria-label={`Supprimer ${brand.name}`}
                      onClick={() => setDeleteTarget(brand)}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      Supprimer
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* État vide */}
        {!isLoading && !isError && (!data?.data || data.data.length === 0) && (
          <EmptyState onAdd={openCreate} />
        )}
      </div>

      {/* État partiel — pagination */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} marques
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Précédent
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              Suivant
            </button>
          </div>
        </div>
      )}

      {/* Modal CRUD */}
      <BrandDialog
        open={dialogOpen}
        onClose={closeDialog}
        initial={
          editTarget
            ? {
                name: editTarget.name,
                description: editTarget.description ?? '',
                image: editTarget.image ?? '',
              }
            : undefined
        }
        onSubmit={handleSubmit}
        isPending={isPendingForm}
        error={activeError ? (activeError as Error).message : null}
      />

      {/* AlertDialog suppression */}
      <DeleteDialog
        open={!!deleteTarget}
        brandName={deleteTarget?.name ?? ''}
        onCancel={() => { setDeleteTarget(null); deleteBrand.reset(); }}
        onConfirm={handleDelete}
        isPending={deleteBrand.isPending}
        error={deleteBrand.error ? (deleteBrand.error as Error).message : null}
      />
    </div>
  );
}

export default BrandsPage;
