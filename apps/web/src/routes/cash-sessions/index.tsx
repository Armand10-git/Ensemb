import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Eye, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { formatXAF, formatDate, formatTime } from '../../lib/utils';
import { Badge } from '../../components/ui/badge';
import { NativeSelect } from '../../components/ui/native-select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import { Button } from '../../components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import { PageHeader, TableSkeleton, EmptyState, ErrorState } from '../../components/page-states';

// ─── Types ───────────────────────────────────────────────────────────────────

type CashSessionStatus = 'OPEN' | 'CLOSED';

/** Tous les Decimal sont sérialisés en string sur le fil (même patron que sales/index.tsx). */
interface CashSessionResponse {
  id: string;
  organizationId: string;
  reference: string;
  warehouseId: string;
  userId: string;
  openingAmount: string;
  expectedClosingAmount: string | null;
  countedClosingAmount: string | null;
  variance: string | null;
  status: CashSessionStatus;
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
}

interface CashSessionSaleSummary { reference: string; grandTotal: string }

interface CashSessionDetail extends CashSessionResponse {
  sales: CashSessionSaleSummary[];
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface WarehouseRef { id: string; name: string }

// ─── API hooks ───────────────────────────────────────────────────────────────

function useWarehouses() {
  return useQuery<Paginated<WarehouseRef>>({
    queryKey: ['warehouses-all'],
    queryFn: () => api.get<Paginated<WarehouseRef>>('/warehouses?limit=200'),
    staleTime: 60_000,
  });
}

function useCashSessions(page: number, limit: number, warehouseId: string, status: string) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (warehouseId) params.set('warehouseId', warehouseId);
  if (status) params.set('status', status);
  return useQuery<Paginated<CashSessionResponse>>({
    queryKey: ['cash-sessions', page, limit, warehouseId, status],
    queryFn: () => api.get<Paginated<CashSessionResponse>>(`/cash-sessions?${params}`),
  });
}

function useCashSessionDetail(id: string | null) {
  return useQuery<CashSessionDetail>({
    queryKey: ['cash-session', id],
    queryFn: () => api.get<CashSessionDetail>(`/cash-sessions/${id!}`),
    enabled: id !== null,
  });
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function SessionStatusBadge({ status }: { status: CashSessionStatus }) {
  return status === 'OPEN'
    ? <Badge variant="info">Ouverte</Badge>
    : <Badge variant="neutral">Clôturée</Badge>;
}

/** Écart de clôture — jamais un nombre nu (standards.md règle 10). */
function VarianceBadge({ variance }: { variance: string | null }) {
  if (variance === null) return <span className="text-neutral-400">—</span>;
  const n = Number(variance);
  if (n > 0) return <Badge variant="success" className="tabular">Excédent {formatXAF(Math.abs(n))}</Badge>;
  if (n < 0) return <Badge variant="danger" className="tabular">Manque {formatXAF(Math.abs(n))}</Badge>;
  return <Badge variant="neutral">Aucun écart</Badge>;
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

function CashSessionDetailView({ session, warehouseName }: { session: CashSessionDetail; warehouseName: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Référence</p>
          <p className="tabular font-semibold text-neutral-900">{session.reference}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Statut</p>
          <SessionStatusBadge status={session.status} />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Entrepôt</p>
          <p className="text-[13.5px] text-neutral-800">{warehouseName}</p>
        </div>
        <div>
          <p className="mb-1 text-[11.5px] text-neutral-500">Ouverte le</p>
          <p className="text-[13.5px] text-neutral-800">{formatDate(session.openedAt)} à {formatTime(session.openedAt)}</p>
        </div>
        {session.closedAt && (
          <div>
            <p className="mb-1 text-[11.5px] text-neutral-500">Clôturée le</p>
            <p className="text-[13.5px] text-neutral-800">{formatDate(session.closedAt)} à {formatTime(session.closedAt)}</p>
          </div>
        )}
      </div>

      {session.notes && (
        <div className="rounded-card bg-neutral-50 px-3.5 py-3 text-[13.5px] text-neutral-700">{session.notes}</div>
      )}

      <div className="grid gap-1.5 rounded-card bg-neutral-50 px-4 py-3">
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Fond de caisse</span><span className="tabular">{formatXAF(session.openingAmount)}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Attendu en caisse</span>
          <span className="tabular">{session.expectedClosingAmount !== null ? formatXAF(session.expectedClosingAmount) : '—'}</span>
        </div>
        <div className="flex justify-between text-[13px] text-neutral-600">
          <span>Montant compté</span>
          <span className="tabular">{session.countedClosingAmount !== null ? formatXAF(session.countedClosingAmount) : '—'}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-neutral-200 pt-2 text-[14px] font-semibold text-neutral-900">
          <span>Écart</span><VarianceBadge variance={session.variance} />
        </div>
      </div>

      <div>
        <p className="mb-2 text-[12.5px] font-semibold text-neutral-700">Ventes rattachées ({session.sales.length})</p>
        {session.sales.length === 0 ? (
          <div className="rounded-card border border-dashed border-neutral-300 bg-white px-3.5 py-5 text-center text-[13px] text-neutral-500">
            Aucune vente rattachée à cette session.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {session.sales.map((s) => (
                <TableRow key={s.reference}>
                  <TableCell className="tabular">{s.reference}</TableCell>
                  <TableCell className="tabular text-right">{formatXAF(s.grandTotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function CashSessionsPage() {
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const { data, isLoading, isError } = useCashSessions(page, limit, filterWarehouse, filterStatus);
  const { data: detail, isLoading: detailLoading } = useCashSessionDetail(detailId);
  const { data: warehouseData } = useWarehouses();
  const warehouses = warehouseData?.data ?? [];

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  function warehouseName(id: string) {
    return warehouses.find((w) => w.id === id)?.name ?? '—';
  }

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Sessions de caisse"
        description="Historique des ouvertures et clôtures de caisse, avec écart de comptage."
      />

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      {!isLoading && !isError && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          <NativeSelect
            className="w-auto min-w-[10rem]"
            value={filterWarehouse}
            onChange={(e) => { setFilterWarehouse(e.target.value); setPage(1); }}
          >
            <option value="">Tous les entrepôts</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </NativeSelect>
          <NativeSelect
            className="w-auto min-w-[9rem]"
            value={filterStatus}
            onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          >
            <option value="">Tous les statuts</option>
            <option value="OPEN">Ouverte</option>
            <option value="CLOSED">Clôturée</option>
          </NativeSelect>
        </div>
      )}

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={7} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message="Impossible de charger les sessions de caisse."
          onRetry={() => void qc.invalidateQueries({ queryKey: ['cash-sessions'] })}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="Aucune session de caisse"
          description="Les sessions ouvertes depuis l'écran Caisse apparaîtront ici, avec l'écart calculé à la clôture."
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Référence</TableHead>
              <TableHead>Entrepôt</TableHead>
              <TableHead>Ouverte le</TableHead>
              <TableHead>Clôturée le</TableHead>
              <TableHead className="text-right">Fond de caisse</TableHead>
              <TableHead>Écart</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id} className="cursor-pointer" onClick={() => setDetailId(s.id)}>
                <TableCell className="tabular font-semibold text-neutral-900">{s.reference}</TableCell>
                <TableCell>{warehouseName(s.warehouseId)}</TableCell>
                <TableCell>{formatDate(s.openedAt)} · {formatTime(s.openedAt)}</TableCell>
                <TableCell>{s.closedAt ? `${formatDate(s.closedAt)} · ${formatTime(s.closedAt)}` : '—'}</TableCell>
                <TableCell className="tabular text-right">{formatXAF(s.openingAmount)}</TableCell>
                <TableCell><VarianceBadge variance={s.variance} /></TableCell>
                <TableCell><SessionStatusBadge status={s.status} /></TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => { e.stopPropagation(); setDetailId(s.id); }}
                    aria-label="Voir le détail"
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
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

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{detail ? `Session ${detail.reference}` : 'Chargement…'}</SheetTitle>
            <SheetDescription>Détail de la session et des ventes rattachées.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-field bg-neutral-100" />)}
              </div>
            )}
            {detail && <CashSessionDetailView session={detail} warehouseName={warehouseName(detail.warehouseId)} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
