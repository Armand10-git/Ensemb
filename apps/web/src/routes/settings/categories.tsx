import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, FolderTree } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
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

// ─── Formulaire création / édition ───────────────────────────────────────────

function CategoryForm({
  initial,
  onSave,
  saving,
}: {
  initial?: Partial<CategoryFormData>;
  onSave: (data: CategoryFormData) => void;
  saving: boolean;
}) {
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ code, name });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="space-y-1.5">
        <Label htmlFor="cat-code">
          Code <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="cat-code"
          required
          maxLength={20}
          placeholder="ex. ELEC"
          className="font-mono uppercase"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <p className="text-[12px] text-neutral-400">Majuscules et chiffres uniquement, 1–20 caractères</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cat-name">
          Nom <span className="text-danger-600">*</span>
        </Label>
        <Input
          id="cat-name"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
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

  const isPendingForm = editTarget ? updateCat.isPending : createCat.isPending;
  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Catégories"
        description="Organisez votre catalogue par catégorie."
        action={
          <Button data-testid="add-category" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Nouvelle catégorie
          </Button>
        }
      />

      {/* ── Recherche côté client ───────────────────────────────────────── */}
      {!isLoading && !isError && (
        <Input
          type="search"
          placeholder="Rechercher par code ou nom…"
          aria-label="Rechercher une catégorie"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-4 max-w-sm"
        />
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={3} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les catégories.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide (sans recherche) ──────────────────────────────────── */}
      {!isLoading && !isError && filteredData.length === 0 && search.trim() === '' && (
        <EmptyState
          icon={FolderTree}
          title="Aucune catégorie"
          description="Créez votre première catégorie pour organiser votre catalogue."
          action={
            <Button data-testid="empty-add-category" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Nouvelle catégorie
            </Button>
          }
        />
      )}

      {/* ── Résultat vide suite à recherche ─────────────────────────────── */}
      {!isLoading && !isError && filteredData.length === 0 && search.trim() !== '' && (
        <EmptyState title={`Aucune catégorie ne correspond à « ${search} »`} />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && filteredData.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredData.map((cat) => (
              <TableRow key={cat.id}>
                <TableCell>
                  <Badge variant="neutral" className="font-mono">{cat.code}</Badge>
                </TableCell>
                <TableCell className="font-semibold text-neutral-900">{cat.name}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Modifier ${cat.code}`}
                      onClick={() => openEdit(cat)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-danger-600 hover:bg-danger-50"
                      aria-label={`Supprimer ${cat.code}`}
                      onClick={() => setDeleteTarget(cat)}
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
            <SheetDescription>Code court et nom affiché dans le catalogue.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <CategoryForm
              key={editTarget?.id ?? 'new'}
              initial={editTarget ? { code: editTarget.code, name: editTarget.name } : undefined}
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
            <AlertDialogTitle>
              Supprimer la catégorie "{deleteTarget?.code ?? ''} — {deleteTarget?.name ?? ''}" ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible. La catégorie sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); deleteCat.reset(); }}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction disabled={deleteCat.isPending} onClick={handleDelete}>
              {deleteCat.isPending ? 'Suppression…' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default CategoriesPage;
