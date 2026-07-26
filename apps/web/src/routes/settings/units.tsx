import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Ruler } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { NativeSelect } from '../../components/ui/native-select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
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

const DEFAULT_FORM: UnitFormData = {
  name: '',
  shortName: '',
  isDerived: false,
  baseUnitId: '',
  operator: '*',
  operatorValue: '1',
};

// ─── Badge de hiérarchie ──────────────────────────────────────────────────────

function BaseUnitBadge({ unit }: { unit: Unit }) {
  if (!unit.baseUnit) return null;
  const val = parseFloat(unit.operatorValue);
  const label = unit.operator === '*' ? `${val} × ${unit.baseUnit.name}` : `÷ ${val} ${unit.baseUnit.name}`;
  return <Badge variant="info">{unit.name} = {label}</Badge>;
}

// ─── Formulaire création / édition ───────────────────────────────────────────

function UnitForm({
  initial,
  baseUnits,
  onSave,
  saving,
}: {
  initial?: Partial<UnitFormData>;
  baseUnits: Unit[];
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<UnitFormData>({ ...DEFAULT_FORM, ...initial });

  const preview = buildPreview(form, baseUnits);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave(buildPayload(form));
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label htmlFor="unit-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="unit-name"
          required
          maxLength={100}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="unit-short-name">
          Nom court <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="unit-short-name"
          required
          maxLength={20}
          placeholder="pcs, ctn, L…"
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
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
            form.isDerived ? 'bg-brand-500' : 'bg-neutral-300',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
              form.isDerived ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
        <span className="text-[13.5px] font-medium text-neutral-700">Unité dérivée</span>
      </div>

      {/* Champs spécifiques aux unités dérivées */}
      {form.isDerived && (
        <div className="flex flex-col gap-3 rounded-card border border-neutral-200 bg-neutral-50 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="unit-base">
              Unité de base <span className="text-danger-600">*</span>
            </Label>
            <NativeSelect
              id="unit-base"
              required={form.isDerived}
              value={form.baseUnitId}
              onChange={(e) => setForm((f) => ({ ...f, baseUnitId: e.target.value }))}
            >
              <option value="">Sélectionner une unité de base…</option>
              {baseUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.shortName})
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="unit-operator-value">Facteur</Label>
              <Input
                id="unit-operator-value"
                type="number"
                min="0.000001"
                step="any"
                required={form.isDerived}
                value={form.operatorValue}
                onChange={(e) => setForm((f) => ({ ...f, operatorValue: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Opérateur</Label>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, operator: '*' }))}
                  className={cn(
                    'h-9 rounded-field border px-3 text-[13.5px] font-medium transition-colors',
                    form.operator === '*'
                      ? 'border-brand-500 bg-brand-500 text-white'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50',
                  )}
                >
                  ×
                </button>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, operator: '/' }))}
                  className={cn(
                    'h-9 rounded-field border px-3 text-[13.5px] font-medium transition-colors',
                    form.operator === '/'
                      ? 'border-brand-500 bg-brand-500 text-white'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50',
                  )}
                >
                  ÷
                </button>
              </div>
            </div>
          </div>

          {/* Aperçu en direct */}
          {preview && (
            <p data-testid="conversion-preview" className="rounded-field bg-brand-50 px-3 py-2 text-[13px] text-brand-700">
              Aperçu : <strong>{preview}</strong>
            </p>
          )}
        </div>
      )}

      <SheetFooter className="border-0 px-0 pb-0 pt-2">
        <Button type="submit" disabled={saving} loading={saving}>
          {!saving && 'Enregistrer'}
        </Button>
      </SheetFooter>
    </form>
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

  const isPendingForm = editTarget ? updateUnit.isPending : createUnit.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;
  const rows = data?.data ?? [];

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
    <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Unités"
        description="Unités de mesure et conditionnements dérivés."
        action={
          <Button data-testid="add-unit" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvelle unité
          </Button>
        }
      />

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={4} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les unités.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Ruler}
          title="Aucune unité"
          description="Créez votre première unité pour gérer les conditionnements."
          action={
            <Button data-testid="empty-add-unit" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Nouvelle unité
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Nom court</TableHead>
              <TableHead>Unité de base</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((unit) => (
              <TableRow key={unit.id}>
                <TableCell className="font-semibold text-neutral-900">{unit.name}</TableCell>
                <TableCell>
                  <Badge variant="neutral" className="font-mono">{unit.shortName}</Badge>
                </TableCell>
                <TableCell>
                  {unit.baseUnit ? (
                    <BaseUnitBadge unit={unit} />
                  ) : (
                    <span className="text-[12px] text-neutral-400">Unité de base</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${unit.name}`}
                      onClick={() => openEdit(unit)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${unit.name}`}
                      onClick={() => setDeleteTarget(unit)}
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

      {/* ── État partiel — pagination ────────────────────────────────────── */}
      {!isLoading && !isError && data && data.total > limit && (
        <div className="mt-4 flex items-center justify-between text-[13px] text-neutral-500">
          <span>
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} unités
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Précédent
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Suivant
            </Button>
          </div>
        </div>
      )}

      {/* ── Sheet création / édition ────────────────────────────────────── */}
      <Sheet open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editTarget ? "Modifier l'unité" : 'Nouvelle unité'}</SheetTitle>
            <SheetDescription>Unité simple ou dérivée d'une unité de base.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <UnitForm
              key={editTarget?.id ?? 'new'}
              initial={initialForm}
              baseUnits={baseUnits}
              onSave={handleSubmit}
              saving={isPendingForm}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ─────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer l'unité "{deleteTarget?.name ?? ''}" ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. L'unité sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteUnit.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction disabled={deleteUnit.isPending} onClick={handleDelete}>
              {deleteUnit.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default UnitsPage;
