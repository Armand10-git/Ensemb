import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
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

interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedExpenseCategories {
  data: ExpenseCategory[];
  total: number;
  page: number;
  limit: number;
}

interface ExpenseCategoryFormData {
  name: string;
  description: string;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Liste paginée des catégories de dépenses de l'organisation. */
function useExpenseCategories(page: number, limit = 20) {
  return useQuery<PaginatedExpenseCategories>({
    queryKey: ['expense-categories', page, limit],
    queryFn: () => api.get<PaginatedExpenseCategories>(`/expense-categories?page=${page}&limit=${limit}`),
  });
}

/** Crée une catégorie de dépense. Invalide la liste au succès. */
function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ExpenseCategoryFormData>) =>
      api.post<ExpenseCategory>('/expense-categories', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expense-categories'] }); },
  });
}

/** Modifie une catégorie de dépense. Invalide la liste au succès. */
function useUpdateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ExpenseCategoryFormData> }) =>
      api.patch<ExpenseCategory>(`/expense-categories/${id}`, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expense-categories'] }); },
  });
}

/** Supprime (soft delete) une catégorie de dépense. Invalide la liste au succès. */
function useDeleteExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/expense-categories/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['expense-categories'] }); },
  });
}

// ─── Formulaire création / édition ───────────────────────────────────────────

/** Formulaire nom + description — pas de champ image (ExpenseCategory n'en a pas). */
function ExpenseCategoryForm({
  initial,
  onSave,
  saving,
}: {
  initial?: Partial<ExpenseCategoryFormData>;
  onSave: (data: Partial<ExpenseCategoryFormData>) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: Partial<ExpenseCategoryFormData> = { name };
    if (description.trim()) payload.description = description;
    onSave(payload);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label htmlFor="expense-category-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="expense-category-name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="expense-category-description">Description</Label>
        <Textarea
          id="expense-category-description"
          maxLength={500}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <SheetFooter className="border-0 px-0 pb-0 pt-2">
        <Button type="submit" disabled={saving} loading={saving}>
          {!saving && 'Enregistrer'}
        </Button>
      </SheetFooter>
    </form>
  );
}

// ─── Écran principal ─────────────────────────────────────────────────────────

export function ExpenseCategoriesPage() {
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data, isLoading, isError, error, refetch } = useExpenseCategories(page, limit);
  const createExpenseCategory = useCreateExpenseCategory();
  const updateExpenseCategory = useUpdateExpenseCategory();
  const deleteExpenseCategory = useDeleteExpenseCategory();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ExpenseCategory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategory | null>(null);

  function openCreate() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function openEdit(category: ExpenseCategory) {
    setEditTarget(category);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditTarget(null);
    createExpenseCategory.reset();
    updateExpenseCategory.reset();
  }

  function handleSubmit(formData: Partial<ExpenseCategoryFormData>) {
    if (editTarget) {
      updateExpenseCategory.mutate(
        { id: editTarget.id, data: formData },
        { onSuccess: closeDialog },
      );
    } else {
      createExpenseCategory.mutate(formData, { onSuccess: closeDialog });
    }
  }

  function handleDelete() {
    if (!deleteTarget) return;
    deleteExpenseCategory.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  }

  const isPendingForm = editTarget ? updateExpenseCategory.isPending : createExpenseCategory.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;
  const rows = data?.data ?? [];

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Catégories de dépenses"
        description="Catégories utilisées pour classer les dépenses."
        action={
          <Button data-testid="add-expense-category" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvelle catégorie
          </Button>
        }
      />

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={3} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les catégories de dépenses.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Tag}
          title="Aucune catégorie de dépense"
          description="Créez votre première catégorie pour classer vos dépenses."
          action={
            <Button data-testid="empty-add-expense-category" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Nouvelle catégorie
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
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="font-semibold text-neutral-900">{category.name}</TableCell>
                <TableCell className="max-w-xs truncate text-neutral-500">
                  {category.description ?? '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${category.name}`}
                      onClick={() => openEdit(category)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${category.name}`}
                      onClick={() => setDeleteTarget(category)}
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
            {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} sur {data.total} catégories
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
            <SheetTitle>{editTarget ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</SheetTitle>
            <SheetDescription>Nom et description de la catégorie de dépense.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ExpenseCategoryForm
              key={editTarget?.id ?? 'new'}
              initial={
                editTarget
                  ? { name: editTarget.name, description: editTarget.description ?? '' }
                  : undefined
              }
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
            <AlertDialogTitle>Supprimer la catégorie "{deleteTarget?.name ?? ''}" ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. La catégorie sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteExpenseCategory.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction disabled={deleteExpenseCategory.isPending} onClick={handleDelete}>
              {deleteExpenseCategory.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default ExpenseCategoriesPage;
