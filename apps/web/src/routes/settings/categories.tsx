import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  code: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedCategories {
  data: Category[];
  total: number;
  page: number;
  limit: number;
}

interface CategoryFormData {
  code: string;
  name: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useCategories(page: number, limit = 20) {
  return useQuery<PaginatedCategories>({
    queryKey: ['categories', page, limit],
    queryFn: () => api.get<PaginatedCategories>(`/catalog/categories?page=${page}&limit=${limit}`),
  });
}

function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CategoryFormData) => api.post<Category>('/catalog/categories', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['categories'] }); },
  });
}

function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CategoryFormData> }) =>
      api.patch<Category>(`/catalog/categories/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['categories'] }); },
  });
}

function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/categories/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['categories'] }); },
  });
}

// ─── Composants ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse" aria-busy="true">
      {[1, 2, 3].map((i) => (
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
      <p className="text-lg font-medium">Aucune catégorie</p>
      <p className="mt-1 text-sm">Créez votre première catégorie pour organiser votre catalogue.</p>
      <button
        data-testid="empty-add-category"
        onClick={onAdd}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Nouvelle catégorie
      </button>
    </div>
  );
}

function CategoryDialog({
  open,
  onClose,
  initial,
  onSubmit,
  isPending,
  error,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<CategoryFormData>;
  onSubmit: (data: CategoryFormData) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<CategoryFormData>({
    code: initial?.code ?? '',
    name: initial?.name ?? '',
  });

  React.useEffect(() => {
    if (open) {
      setForm({ code: initial?.code ?? '', name: initial?.name ?? '' });
    }
  }, [open, initial?.code, initial?.name]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={initial?.code ? 'Modifier la catégorie' : 'Nouvelle catégorie'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {initial?.code ? 'Modifier la catégorie' : 'Nouvelle catégorie'}
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(form);
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="cat-code">
              Code <span className="text-red-500">*</span>
            </label>
            <input
              id="cat-code"
              type="text"
              required
              maxLength={20}
              placeholder="ex. ELEC"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.code}
              onChange={(e) =>
                setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))
              }
            />
            <p className="mt-1 text-xs text-gray-400">Majuscules et chiffres uniquement, 1–20 caractères</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="cat-name">
              Nom <span className="text-red-500">*</span>
            </label>
            <input
              id="cat-name"
              type="text"
              required
              maxLength={100}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
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
  categoryName,
  categoryCode,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  open: boolean;
  categoryName: string;
  categoryCode: string;
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
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Supprimer la catégorie</h2>
        <p className="mb-4 text-sm text-gray-600">
          Voulez-vous vraiment supprimer la catégorie{' '}
          <span className="font-semibold text-gray-900">"{categoryCode} — {categoryName}"</span> ?
          Cette action ne peut pas être annulée.
        </p>
        {error && (
          <div role="alert" className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
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

export function CategoriesPage() {
  const [page, setPage] = useState(1);
  const limit = 20;
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, refetch } = useCategories(page, limit);
  const createCat = useCreateCategory();
  const updateCat = useUpdateCategory();
  const deleteCat = useDeleteCategory();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Category | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);

  const filteredData = useMemo(() => {
    if (!data?.data || !search.trim()) return data?.data ?? [];
    const q = search.toLowerCase();
    return data.data.filter(
      (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    );
  }, [data?.data, search]);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(cat: Category) {
    setEditTarget(cat);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createCat.reset();
    updateCat.reset();
  }

  function handleSubmit(formData: CategoryFormData) {
    if (editTarget) {
      updateCat.mutate(
        { id: editTarget.id, data: formData },
        { onSuccess: closeDialog },
      );
    } else {
      createCat.mutate(formData, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteCat.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const activeError = editTarget ? updateCat.error : createCat.error;
  const isPendingForm = editTarget ? updateCat.isPending : createCat.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Catégories</h1>
        <button
          data-testid="add-category"
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Nouvelle catégorie
        </button>
      </div>

      {/* Recherche côté client */}
      <input
        type="search"
        placeholder="Rechercher par code ou nom…"
        aria-label="Rechercher une catégorie"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {/* État erreur */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Impossible de charger les catégories.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* Tableau */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Code', 'Nom', 'Actions'].map((h) => (
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
            {!isLoading && !isError && filteredData.map((cat) => (
              <tr key={cat.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 font-mono text-xs font-medium text-gray-800">
                    {cat.code}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{cat.name}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      aria-label={`Modifier ${cat.code}`}
                      onClick={() => openEdit(cat)}
                      className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                    >
                      Modifier
                    </button>
                    <button
                      aria-label={`Supprimer ${cat.code}`}
                      onClick={() => setDeleteTarget(cat)}
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
        {!isLoading && !isError && filteredData.length === 0 && search.trim() === '' && (
          <EmptyState onAdd={openCreate} />
        )}

        {/* Résultat vide suite à recherche */}
        {!isLoading && !isError && filteredData.length === 0 && search.trim() !== '' && (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400 text-sm">
            Aucune catégorie ne correspond à « {search} »
          </div>
        )}
      </div>

      {/* État partiel — pagination */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} catégories
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
      <CategoryDialog
        open={dialogOpen}
        onClose={closeDialog}
        initial={editTarget ? { code: editTarget.code, name: editTarget.name } : undefined}
        onSubmit={handleSubmit}
        isPending={isPendingForm}
        error={activeError ? (activeError as Error).message : null}
      />

      {/* AlertDialog suppression */}
      <DeleteDialog
        open={!!deleteTarget}
        categoryName={deleteTarget?.name ?? ''}
        categoryCode={deleteTarget?.code ?? ''}
        onCancel={() => { setDeleteTarget(null); deleteCat.reset(); }}
        onConfirm={handleDelete}
        isPending={deleteCat.isPending}
        error={deleteCat.error ? (deleteCat.error as Error).message : null}
      />
    </div>
  );
}

export default CategoriesPage;
