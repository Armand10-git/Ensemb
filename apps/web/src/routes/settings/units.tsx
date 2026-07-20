import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BaseUnitSummary {
  id: string;
  name: string;
  shortName: string;
}

interface Unit {
  id: string;
  name: string;
  shortName: string;
  baseUnitId: string | null;
  baseUnit: BaseUnitSummary | null;
  operator: string;
  operatorValue: string;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedUnits {
  data: Unit[];
  total: number;
  page: number;
  limit: number;
}

interface UnitFormData {
  name: string;
  shortName: string;
  isDerived: boolean;
  baseUnitId: string;
  operator: '*' | '/';
  operatorValue: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useUnits(page: number, limit = 20) {
  return useQuery<PaginatedUnits>({
    queryKey: ['units', page, limit],
    queryFn: () => api.get<PaginatedUnits>(`/catalog/units?page=${page}&limit=${limit}`),
  });
}

function useCreateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => api.post<Unit>('/catalog/units', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['units'] }); },
  });
}

function useUpdateUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.patch<Unit>(`/catalog/units/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['units'] }); },
  });
}

function useDeleteUnit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/units/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['units'] }); },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Génère la formule d'aperçu en direct : "1 Carton = 12 Pièces" */
function buildPreview(form: UnitFormData, baseUnits: Unit[]): string | null {
  if (!form.isDerived) return null;
  const base = baseUnits.find((u) => u.id === form.baseUnitId);
  if (!base) return null;
  const val = parseFloat(form.operatorValue);
  if (!Number.isFinite(val) || val <= 0) return null;
  if (form.operator === '*') {
    return `1 ${form.name || '…'} = ${val} ${base.name}`;
  }
  return `${val} ${form.name || '…'} = 1 ${base.name}`;
}

function buildPayload(form: UnitFormData): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: form.name,
    shortName: form.shortName,
    operator: form.operator,
    operatorValue: form.operatorValue,
  };
  if (form.isDerived && form.baseUnitId) {
    base.baseUnitId = form.baseUnitId;
  }
  return base;
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
      <p className="text-lg font-medium">Aucune unité</p>
      <p className="mt-1 text-sm">Créez votre première unité pour gérer les conditionnements.</p>
      <button
        data-testid="empty-add-unit"
        onClick={onAdd}
        className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Nouvelle unité
      </button>
    </div>
  );
}

function BaseUnitBadge({ unit }: { unit: Unit }) {
  if (!unit.baseUnit) return null;
  const val = parseFloat(unit.operatorValue);
  const label =
    unit.operator === '*'
      ? `${val} × ${unit.baseUnit.name}`
      : `÷ ${val} ${unit.baseUnit.name}`;
  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
      {unit.name} = {label}
    </span>
  );
}

// ─── Dialog création / édition ───────────────────────────────────────────────

const DEFAULT_FORM: UnitFormData = {
  name: '',
  shortName: '',
  isDerived: false,
  baseUnitId: '',
  operator: '*',
  operatorValue: '1',
};

function UnitDialog({
  open,
  onClose,
  initial,
  onSubmit,
  isPending,
  error,
  baseUnits,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<UnitFormData>;
  onSubmit: (data: Record<string, unknown>) => void;
  isPending: boolean;
  error: string | null;
  baseUnits: Unit[];
}) {
  const [form, setForm] = useState<UnitFormData>({ ...DEFAULT_FORM, ...initial });

  React.useEffect(() => {
    if (open) {
      setForm({ ...DEFAULT_FORM, ...initial });
    }
  }, [open]);

  if (!open) return null;

  const preview = buildPreview(form, baseUnits);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(buildPayload(form));
  }

  const isEdit = Boolean(initial?.name);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "Modifier l'unité" : 'Nouvelle unité'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {isEdit ? "Modifier l'unité" : 'Nouvelle unité'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="unit-name">
              Nom <span className="text-red-500">*</span>
            </label>
            <input
              id="unit-name"
              type="text"
              required
              maxLength={100}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700" htmlFor="unit-short-name">
              Nom court <span className="text-red-500">*</span>
            </label>
            <input
              id="unit-short-name"
              type="text"
              required
              maxLength={20}
              placeholder="pcs, ctn, L…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.shortName}
              onChange={(e) => setForm((f) => ({ ...f, shortName: e.target.value }))}
            />
          </div>

          {/* Switch Unité dérivée */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={form.isDerived}
              data-testid="switch-derived"
              onClick={() => setForm((f) => ({ ...f, isDerived: !f.isDerived }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                form.isDerived ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  form.isDerived ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
            <span className="text-sm font-medium text-gray-700">Unité dérivée</span>
          </div>

          {/* Champs spécifiques aux unités dérivées */}
          {form.isDerived && (
            <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div>
                <label className="block text-sm font-medium text-gray-700" htmlFor="unit-base">
                  Unité de base <span className="text-red-500">*</span>
                </label>
                <select
                  id="unit-base"
                  required={form.isDerived}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.baseUnitId}
                  onChange={(e) => setForm((f) => ({ ...f, baseUnitId: e.target.value }))}
                >
                  <option value="">Sélectionner une unité de base…</option>
                  {baseUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.shortName})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700" htmlFor="unit-operator-value">
                    Facteur
                  </label>
                  <input
                    id="unit-operator-value"
                    type="number"
                    min="0.000001"
                    step="any"
                    required={form.isDerived}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={form.operatorValue}
                    onChange={(e) => setForm((f) => ({ ...f, operatorValue: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Opérateur</label>
                  <div className="mt-1 flex gap-1">
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, operator: '*' }))}
                      className={`rounded-md border px-3 py-2 text-sm font-medium ${
                        form.operator === '*'
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      ×
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, operator: '/' }))}
                      className={`rounded-md border px-3 py-2 text-sm font-medium ${
                        form.operator === '/'
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      ÷
                    </button>
                  </div>
                </div>
              </div>

              {/* Aperçu en direct */}
              {preview && (
                <p
                  data-testid="conversion-preview"
                  className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700"
                >
                  Aperçu : <strong>{preview}</strong>
                </p>
              )}
            </div>
          )}

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

// ─── AlertDialog suppression ─────────────────────────────────────────────────

function DeleteDialog({
  open,
  unitName,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  open: boolean;
  unitName: string;
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
        <h2 className="mb-2 text-lg font-semibold text-gray-900">Supprimer l'unité</h2>
        <p className="mb-4 text-sm text-gray-600">
          Voulez-vous vraiment supprimer l'unité{' '}
          <span className="font-semibold text-gray-900">"{unitName}"</span> ?
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

export function UnitsPage() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, isError, error, refetch } = useUnits(page, limit);
  const createUnit = useCreateUnit();
  const updateUnit = useUpdateUnit();
  const deleteUnit = useDeleteUnit();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Unit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Unit | null>(null);

  // Unités de base actives disponibles pour le sélecteur "Unité de base"
  const baseUnits = (data?.data ?? []).filter((u) => u.baseUnitId === null);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(unit: Unit) {
    setEditTarget(unit);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createUnit.reset();
    updateUnit.reset();
  }

  function handleSubmit(payload: Record<string, unknown>) {
    if (editTarget) {
      updateUnit.mutate(
        { id: editTarget.id, data: payload },
        { onSuccess: closeDialog },
      );
    } else {
      createUnit.mutate(payload, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteUnit.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const activeError = editTarget ? updateUnit.error : createUnit.error;
  const isPendingForm = editTarget ? updateUnit.isPending : createUnit.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  const initialForm: Partial<UnitFormData> | undefined = editTarget
    ? {
        name: editTarget.name,
        shortName: editTarget.shortName,
        isDerived: editTarget.baseUnitId !== null,
        baseUnitId: editTarget.baseUnitId ?? '',
        operator: (editTarget.operator as '*' | '/') ?? '*',
        operatorValue: editTarget.operatorValue,
      }
    : undefined;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Unités</h1>
        <button
          data-testid="add-unit"
          onClick={openCreate}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Nouvelle unité
        </button>
      </div>

      {/* État erreur */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Impossible de charger les unités.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* Tableau */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Nom', 'Nom court', 'Unité de base', 'Actions'].map((h) => (
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

            {/* État succès / partiel */}
            {!isLoading && !isError && data?.data.map((unit) => (
              <tr key={unit.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{unit.name}</td>
                <td className="px-4 py-3 text-gray-500">
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">
                    {unit.shortName}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {unit.baseUnit ? (
                    <BaseUnitBadge unit={unit} />
                  ) : (
                    <span className="text-gray-400 text-xs">Unité de base</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button
                      aria-label={`Modifier ${unit.name}`}
                      onClick={() => openEdit(unit)}
                      className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                    >
                      Modifier
                    </button>
                    <button
                      aria-label={`Supprimer ${unit.name}`}
                      onClick={() => setDeleteTarget(unit)}
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
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} unités
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
      <UnitDialog
        open={dialogOpen}
        onClose={closeDialog}
        initial={initialForm}
        onSubmit={handleSubmit}
        isPending={isPendingForm}
        error={activeError ? (activeError as Error).message : null}
        baseUnits={baseUnits}
      />

      {/* AlertDialog suppression */}
      <DeleteDialog
        open={!!deleteTarget}
        unitName={deleteTarget?.name ?? ''}
        onCancel={() => { setDeleteTarget(null); deleteUnit.reset(); }}
        onConfirm={handleDelete}
        isPending={deleteUnit.isPending}
        error={deleteUnit.error ? (deleteUnit.error as Error).message : null}
      />
    </div>
  );
}

export default UnitsPage;
