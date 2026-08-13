import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronLeft, ChevronRight, Receipt } from 'lucide-react';
import { api } from '../../lib/api';
import { formatXAF, formatDate } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { NativeSelect } from '../../components/ui/native-select';
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

/**
 * Expense — entité plate (§ tâche S29) : pas de lignes de détail, pas de statut de cycle de
 * vie. ExpenseResponse côté API ne contient QUE expenseCategoryId/warehouseId (pas de
 * relation incluse) — les noms sont résolus côté client via useExpenseCategories/useWarehouses.
 */
interface Expense {
  id: string;
  reference: string;
  date: string;
  expenseCategoryId: string;
  warehouseId: string;
  details: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface ExpenseCategoryRef { id: string; name: string }
interface WarehouseRef { id: string; name: string }

interface ExpenseFormData {
  date: string;
  expenseCategoryId: string;
  warehouseId: string;
  details: string;
  amount: string;
}

// ─── API Hooks ───────────────────────────────────────────────────────────────

/** Liste paginée des dépenses, filtrable par catégorie, entrepôt et date. */
function useExpenses(
  page: number,
  limit: number,
  expenseCategoryId: string,
  warehouseId: string,
  date: string,
) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (expenseCategoryId) params.set('expenseCategoryId', expenseCategoryId);
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (date) params.set('date', date);
  return useQuery<Paginated<Expense>>({
    queryKey: ['expenses', page, limit, expenseCategoryId, warehouseId, date],
    queryFn: () => api.get<Paginated<Expense>>(`/expenses?${params}`),
  });
}

/** Catégories de dépenses de l'organisation — mirror useProviders de purchases/index.tsx. */
function useExpenseCategories() {
  return useQuery<Paginated<ExpenseCategoryRef>>({
    queryKey: ['expense-categories-all'],
    queryFn: () => api.get<Paginated<ExpenseCategoryRef>>('/expense-categories?limit=200'),
    staleTime: 60_000,
  });
}

/** Entrepôts de l'organisation — mirror useWarehouses de purchases/index.tsx. */
function useWarehouses() {
  return useQuery<Paginated<WarehouseRef>>({
    queryKey: ['warehouses-all'],
    queryFn: () => api.get<Paginated<WarehouseRef>>('/warehouses?limit=200'),
    staleTime: 60_000,
  });
}

/** Crée une dépense. Invalide la liste au succès. */
function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ExpenseFormData>) => api.post<Expense>('/expenses', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expenses'] }); },
  });
}

/** Modifie une dépense. Invalide la liste au succès. */
function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ExpenseFormData> }) =>
      api.patch<Expense>(`/expenses/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expenses'] }); },
  });
}

/** Supprime (soft delete) une dépense. Invalide la liste au succès. */
function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/expenses/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expenses'] }); },
  });
}

// ─── Formulaire création / édition ───────────────────────────────────────────

/**
 * Formulaire de dépense — réutilisé pour création et édition (key={editTarget?.id ?? 'new'}
 * côté page principale, mirror BrandForm). Pas de vue détail séparée : l'édition se fait
 * directement via ce formulaire, comme un écran de réglages.
 */
function ExpenseForm({
  categories,
  warehouses,
  initial,
  onSave,
  saving,
}: {
  categories: ExpenseCategoryRef[];
  warehouses: WarehouseRef[];
  initial?: Partial<ExpenseFormData>;
  onSave: (data: Partial<ExpenseFormData>) => void;
  saving: boolean;
}) {
  const [date, setDate] = useState(initial?.date ?? new Date().toISOString().slice(0, 10));
  const [expenseCategoryId, setExpenseCategoryId] = useState(initial?.expenseCategoryId ?? '');
  const [warehouseId, setWarehouseId] = useState(initial?.warehouseId ?? '');
  const [details, setDetails] = useState(initial?.details ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      date: new Date(date).toISOString(),
      expenseCategoryId,
      warehouseId,
      details,
      amount,
    });
  }

  const canSubmit = date !== '' && expenseCategoryId !== '' && warehouseId !== '' && details.trim() !== '' && amount !== '';

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label htmlFor="expense-date">
          Date <span className="text-danger-600">*</span>
        </Label>
        <Input id="expense-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label>
          Catégorie <span className="text-danger-600">*</span>
        </Label>
        <NativeSelect
          value={expenseCategoryId}
          onChange={(e) => setExpenseCategoryId(e.target.value)}
          data-testid="expense-category-select"
        >
          <option value="">— Catégorie —</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Label>
          Entrepôt <span className="text-danger-600">*</span>
        </Label>
        <NativeSelect
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          data-testid="expense-warehouse-select"
        >
          <option value="">— Entrepôt —</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </NativeSelect>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="expense-details">
          Détails <span className="text-danger-600">*</span>
        </Label>
        <Textarea
          id="expense-details"
          required
          maxLength={1000}
          rows={3}
          placeholder="Description de la dépense…"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="expense-amount">
          Montant (XAF) <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="expense-amount"
          required
          className="tabular"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={!canSubmit} loading={saving} size="lg">
        {!saving && 'Enregistrer'}
        {saving && 'Enregistrement…'}
      </Button>
    </form>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

/** Écran des dépenses (S29) — CRUD plat, sans cycle de vie ni vue détail séparée. */
export default function ExpensesPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterCategory, setFilterCategory]   = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterDate, setFilterDate]           = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);

  const { data, isLoading, isError } = useExpenses(page, limit, filterCategory, filterWarehouse, filterDate);
  const { data: categoryData }  = useExpenseCategories();
  const { data: warehouseData } = useWarehouses();

  const categories  = categoryData?.data ?? [];
  const warehouses  = warehouseData?.data ?? [];

  const createMutation = useCreateExpense();
  const updateMutation = useUpdateExpense();
  const deleteMutation = useDeleteExpense();

  function openCreate() {
    setEditTarget(null);
    setSheetOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditTarget(expense);
    setSheetOpen(true);
  }

  function closeSheet() {
    setSheetOpen(false);
    setEditTarget(null);
    createMutation.reset();
    updateMutation.reset();
  }

  async function handleSave(payload: Partial<ExpenseFormData>) {
    try {
      if (editTarget) {
        await updateMutation.mutateAsync({ id: editTarget.id, data: payload });
        toast.success('Dépense modifiée.');
      } else {
        const created = await createMutation.mutateAsync(payload);
        toast.success(`Dépense créée. Référence : ${created.reference}`);
      }
      closeSheet();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'enregistrement de la dépense.");
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast.success('Dépense supprimée.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la suppression.');
    }
  }

  const isPendingForm = editTarget ? updateMutation.isPending : createMutation.isPending;
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Dépenses"
        description="Suivi des dépenses de l'organisation."
        action={
          <Button data-testid="add-expense" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvelle dépense
          </Button>
        }
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterCategory}
            onChange={(e) => { setFilterCategory(e.target.value); setPage(1); }}
          >
            <option value="">Toutes les catégories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterWarehouse}
            onChange={(e) => { setFilterWarehouse(e.target.value); setPage(1); }}
          >
            <option value="">Tous les entrepôts</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          <Input
            type="date"
            className="w-auto"
            value={filterDate}
            onChange={(e) => { setFilterDate(e.target.value); setPage(1); }}
          />
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={5} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState message="Impossible de charger les dépenses." onRetry={() => void qc.invalidateQueries({ queryKey: ['expenses'] })} />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Receipt}
          title="Aucune dépense"
          description="Enregistrez votre première dépense."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Nouvelle dépense
            </Button>
          }
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Référence</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Catégorie</TableHead>
              <TableHead>Entrepôt</TableHead>
              <TableHead className="text-right">Montant</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((expense) => {
              const categoryName = categories.find((c) => c.id === expense.expenseCategoryId)?.name ?? '—';
              const warehouseName = warehouses.find((w) => w.id === expense.warehouseId)?.name ?? '—';
              return (
                <TableRow key={expense.id} className="cursor-pointer" onClick={() => openEdit(expense)}>
                  <TableCell className="tabular font-semibold text-neutral-900">{expense.reference}</TableCell>
                  <TableCell>{formatDate(expense.date)}</TableCell>
                  <TableCell>{categoryName}</TableCell>
                  <TableCell>{warehouseName}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(expense.amount)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Modifier ${expense.reference}`}
                        onClick={(e) => { e.stopPropagation(); openEdit(expense); }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-danger-600 hover:bg-danger-50"
                        aria-label={`Supprimer ${expense.reference}`}
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(expense); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
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

      {/* ── Sheet création / édition ────────────────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{editTarget ? `Modifier la dépense ${editTarget.reference}` : 'Nouvelle dépense'}</SheetTitle>
            <SheetDescription>Catégorie, entrepôt, détails et montant de la dépense.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ExpenseForm
              key={editTarget?.id ?? 'new'}
              categories={categories}
              warehouses={warehouses}
              initial={
                editTarget
                  ? {
                      date: editTarget.date.slice(0, 10),
                      expenseCategoryId: editTarget.expenseCategoryId,
                      warehouseId: editTarget.warehouseId,
                      details: editTarget.details,
                      amount: editTarget.amount,
                    }
                  : undefined
              }
              onSave={(payload) => void handleSave(payload)}
              saving={isPendingForm}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la dépense {deleteTarget?.reference ?? ''} ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. La dépense sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteMutation.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction disabled={deleteMutation.isPending} onClick={() => void handleDelete()}>
              {deleteMutation.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
