import React, { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

type DocumentStatus = 'PENDING' | 'AWAITING_PAYMENT' | 'COMPLETED' | 'CANCELLED';
type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

interface SaleDetail {
  id: string;
  productId: string;
  productVariantId: string | null;
  saleUnitId: string | null;
  price: string;
  taxAmount: string | null;
  taxMethod: string | null;
  discount: string | null;
  discountMethod: string | null;
  quantity: string;
  total: string;
}

interface Sale {
  id: string;
  reference: string;
  date: string;
  clientId: string;
  warehouseId: string;
  taxRate: string | null;
  taxAmount: string | null;
  discount: string | null;
  shipping: string | null;
  grandTotal: string;
  paidAmount: string;
  paymentStatus: PaymentStatus;
  status: DocumentStatus;
  notes: string | null;
  createdAt: string;
  client?: { id: string; name: string };
  warehouse?: { id: string; name: string };
  details?: SaleDetail[];
}

interface Paginated<T> { data: T[]; total: number; page: number; limit: number }

interface ClientRef { id: string; name: string }
interface WarehouseRef { id: string; name: string }
interface ProductRef { id: string; code: string; name: string; price: string }

interface DetailFormRow {
  productId: string;
  quantity: string;
  price: string;
  discount: string;
  taxAmount: string;
}

interface Toast { id: number; message: string; type: 'success' | 'error' }

// ─── API Hooks ───────────────────────────────────────────────────────────────

function useSales(
  page: number,
  limit: number,
  clientId: string,
  warehouseId: string,
  status: string,
  paymentStatus: string,
) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (clientId)      params.set('clientId', clientId);
  if (warehouseId)   params.set('warehouseId', warehouseId);
  if (status)        params.set('status', status);
  if (paymentStatus) params.set('paymentStatus', paymentStatus);
  return useQuery<Paginated<Sale>>({
    queryKey: ['sales', page, limit, clientId, warehouseId, status, paymentStatus],
    queryFn: () => api.get<Paginated<Sale>>(`/sales?${params}`),
  });
}

function useSaleDetail(id: string | null) {
  return useQuery<Sale>({
    queryKey: ['sale', id],
    queryFn: () => api.get<Sale>(`/sales/${id!}`),
    enabled: id !== null,
  });
}

function useClients() {
  return useQuery<Paginated<ClientRef>>({
    queryKey: ['clients-all'],
    queryFn: () => api.get<Paginated<ClientRef>>('/partners/clients?limit=200'),
    staleTime: 60_000,
  });
}

function useWarehouses() {
  return useQuery<Paginated<WarehouseRef>>({
    queryKey: ['warehouses-all'],
    queryFn: () => api.get<Paginated<WarehouseRef>>('/warehouses?limit=200'),
    staleTime: 60_000,
  });
}

function useProducts() {
  return useQuery<Paginated<ProductRef>>({
    queryKey: ['products-all'],
    queryFn: () => api.get<Paginated<ProductRef>>('/catalog/products?limit=500'),
    staleTime: 60_000,
  });
}

function useCreateSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: unknown) => api.post<Sale>('/sales', data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales'] }); },
  });
}

function useDeleteSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/sales/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sales'] }); },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatXAF(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(n)) return '—';
  return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} XAF`;
}

function makeEmptyRow(): DetailFormRow {
  return { productId: '', quantity: '', price: '', discount: '0', taxAmount: '0' };
}

/** Calcul indicatif côté client — le serveur recalcule tout, ceci n'est qu'un aperçu. */
function computeLinePreview(row: DetailFormRow): number {
  const price = parseFloat(row.price) || 0;
  const quantity = parseFloat(row.quantity) || 0;
  const subTotal = price * quantity;
  const tax = subTotal * ((parseFloat(row.taxAmount) || 0) / 100);
  const discount = subTotal * ((parseFloat(row.discount) || 0) / 100);
  return subTotal + tax - discount;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: t.type === 'success' ? '#16a34a' : '#dc2626',
            color: '#fff',
            padding: '12px 20px',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,.18)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 280,
          }}
        >
          <span style={{ flex: 1 }}>{t.message}</span>
          <button onClick={() => onDismiss(t.id)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  return { toasts, add, dismiss };
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function PaymentBadge({ status }: { status: PaymentStatus }) {
  const map: Record<PaymentStatus, { label: string; bg: string; fg: string; bd: string }> = {
    UNPAID:  { label: 'Non payé', bg: '#fee2e2', fg: '#991b1b', bd: '#fca5a5' },
    PARTIAL: { label: 'Partiel',  bg: '#fef9c3', fg: '#854d0e', bd: '#fde047' },
    PAID:    { label: 'Payé',     bg: '#dcfce7', fg: '#15803d', bd: '#86efac' },
  };
  const s = map[status];
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg, border: `1px solid ${s.bd}` }}>
      {s.label}
    </span>
  );
}

function StatusBadge({ status }: { status: DocumentStatus }) {
  const map: Record<DocumentStatus, { label: string; bg: string; fg: string; bd: string }> = {
    PENDING:          { label: 'En attente',        bg: '#fef9c3', fg: '#854d0e', bd: '#fde047' },
    AWAITING_PAYMENT: { label: 'Paiement en cours',  bg: '#dbeafe', fg: '#1e40af', bd: '#93c5fd' },
    COMPLETED:        { label: 'Terminée',           bg: '#dcfce7', fg: '#15803d', bd: '#86efac' },
    CANCELLED:        { label: 'Annulée',            bg: '#f3f4f6', fg: '#4b5563', bd: '#d1d5db' },
  };
  const s = map[status];
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg, border: `1px solid ${s.bd}` }}>
      {s.label}
    </span>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function Skeleton({ height = 24, width = '100%' }: { height?: number; width?: number | string }) {
  return (
    <div
      style={{
        height,
        width,
        background: 'linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: 4,
      }}
    />
  );
}

// ─── Sheet (panneau latéral) ─────────────────────────────────────────────────

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 1000 }}
      />
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 640,
          background: '#fff', zIndex: 1001, display: 'flex', flexDirection: 'column',
          boxShadow: '-4px 0 24px rgba(0,0,0,.12)', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
        </div>
        <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>{children}</div>
      </div>
    </>
  );
}

// ─── AlertDialog ─────────────────────────────────────────────────────────────

function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  if (!open) return null;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 2000 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        background: '#fff', borderRadius: 12, padding: '32px 28px', zIndex: 2001,
        width: 420, boxShadow: '0 8px 32px rgba(0,0,0,.16)',
      }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 17 }}>{title}</h3>
        <p style={{ margin: '0 0 24px', color: '#6b7280', fontSize: 14 }}>{description}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onCancel} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            Annuler
          </button>
          <button onClick={onConfirm} disabled={loading} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {loading ? 'Suppression…' : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Formulaire de création ───────────────────────────────────────────────────

function SaleForm({
  clients,
  warehouses,
  products,
  onSave,
  saving,
}: {
  clients: ClientRef[];
  warehouses: WarehouseRef[];
  products: ProductRef[];
  onSave: (data: unknown) => void;
  saving: boolean;
}) {
  const [clientId, setClientId]       = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate]               = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes]             = useState('');
  const [discount, setDiscount]       = useState('0');
  const [shipping, setShipping]       = useState('0');
  const [taxRate, setTaxRate]         = useState('0');
  const [rows, setRows]               = useState<DetailFormRow[]>([makeEmptyRow()]);

  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db',
    fontSize: 14, boxSizing: 'border-box',
  };

  function setRow<K extends keyof DetailFormRow>(idx: number, key: K, value: DetailFormRow[K]) {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
  }

  function addRow() { setRows((prev) => [...prev, makeEmptyRow()]); }
  function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

  function onSelectProduct(idx: number, productId: string) {
    const product = products.find((p) => p.id === productId);
    setRows((prev) => prev.map((r, i) => i === idx
      ? { ...r, productId, price: r.price || (product ? product.price : r.price) }
      : r));
  }

  const sumLines = rows.reduce((acc, r) => acc + computeLinePreview(r), 0);
  const taxGlobalPreview = sumLines * ((parseFloat(taxRate) || 0) / 100);
  const grandTotalPreview = sumLines + taxGlobalPreview - (parseFloat(discount) || 0) + (parseFloat(shipping) || 0);

  function buildPayload() {
    return {
      clientId,
      warehouseId,
      date: new Date(date).toISOString(),
      notes: notes || undefined,
      taxRate,
      discount,
      shipping,
      details: rows.map((r) => ({
        productId: r.productId,
        quantity: r.quantity,
        price: r.price,
        discount: r.discount || '0',
        taxAmount: r.taxAmount || '0',
      })),
    };
  }

  const canSubmit = clientId && warehouseId && date
    && rows.every((r) => r.productId && r.quantity && r.price);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Client *</label>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={fieldStyle} data-testid="client-select">
            <option value="">— Client —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Entrepôt *</label>
          <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={fieldStyle} data-testid="warehouse-select">
            <option value="">— Entrepôt —</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date *</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={fieldStyle} />
      </div>

      <div>
        <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={1000}
          style={{ ...fieldStyle, resize: 'vertical' }}
          placeholder="Note interne…"
        />
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Lignes *</label>
          <button onClick={addRow} style={{ fontSize: 13, padding: '4px 12px', borderRadius: 6, border: '1px solid #2563eb', color: '#2563eb', background: '#fff', cursor: 'pointer' }}>
            + Ajouter une ligne
          </button>
        </div>

        {rows.map((row, idx) => (
          <div key={idx} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10, display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
              <select
                value={row.productId}
                onChange={(e) => onSelectProduct(idx, e.target.value)}
                style={fieldStyle}
              >
                <option value="">— Produit —</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
              </select>
              {rows.length > 1 && (
                <button onClick={() => removeRow(idx)} style={{ border: 'none', background: '#fee2e2', color: '#dc2626', borderRadius: 6, cursor: 'pointer', padding: '0 10px', fontWeight: 700 }}>×</button>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Quantité *</label>
                <input type="text" value={row.quantity} onChange={(e) => setRow(idx, 'quantity', e.target.value)} placeholder="1" style={{ ...fieldStyle, marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Prix unitaire *</label>
                <input type="text" value={row.price} onChange={(e) => setRow(idx, 'price', e.target.value)} placeholder="0" style={{ ...fieldStyle, marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Remise (%)</label>
                <input type="text" value={row.discount} onChange={(e) => setRow(idx, 'discount', e.target.value)} placeholder="0" style={{ ...fieldStyle, marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Taxe (%)</label>
                <input type="text" value={row.taxAmount} onChange={(e) => setRow(idx, 'taxAmount', e.target.value)} placeholder="0" style={{ ...fieldStyle, marginTop: 4 }} />
              </div>
            </div>

            <p style={{ margin: 0, textAlign: 'right', fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>
              Total ligne (indicatif) : <strong>{formatXAF(computeLinePreview(row))}</strong>
            </p>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: '#6b7280' }}>TVA globale (%)</label>
          <input type="text" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} style={{ ...fieldStyle, marginTop: 4 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#6b7280' }}>Remise globale (XAF)</label>
          <input type="text" value={discount} onChange={(e) => setDiscount(e.target.value)} style={{ ...fieldStyle, marginTop: 4 }} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: '#6b7280' }}>Frais de port (XAF)</label>
          <input type="text" value={shipping} onChange={(e) => setShipping(e.target.value)} style={{ ...fieldStyle, marginTop: 4 }} />
        </div>
      </div>

      <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 16px', textAlign: 'right' }}>
        <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Total indicatif (recalculé par le serveur)</p>
        <p style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatXAF(grandTotalPreview)}</p>
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 8 }}>
        <button
          onClick={() => onSave(buildPayload())}
          disabled={!canSubmit || saving}
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 6, border: 'none',
            background: '#2563eb', color: '#fff', cursor: canSubmit ? 'pointer' : 'not-allowed',
            fontWeight: 600, fontSize: 14, opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

// ─── Vue détail ───────────────────────────────────────────────────────────────

function SaleDetailView({
  sale,
  products,
  onDelete,
  deleting,
}: {
  sale: Sale;
  products: ProductRef[];
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Référence</p>
          <p style={{ margin: 0, fontWeight: 700, fontFamily: 'monospace' }}>{sale.reference}</p>
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Statuts</p>
          <div style={{ display: 'flex', gap: 6 }}>
            <StatusBadge status={sale.status} />
            <PaymentBadge status={sale.paymentStatus} />
          </div>
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Date</p>
          <p style={{ margin: 0 }}>{formatDate(sale.date)}</p>
        </div>
        <div>
          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280' }}>Client / Entrepôt</p>
          <p style={{ margin: 0 }}>{sale.client?.name ?? sale.clientId} — {sale.warehouse?.name ?? sale.warehouseId}</p>
        </div>
      </div>

      {sale.notes && (
        <div style={{ background: '#f9fafb', borderRadius: 8, padding: 12, fontSize: 14, color: '#374151' }}>
          {sale.notes}
        </div>
      )}

      <div>
        <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>Lignes ({sale.details?.length ?? 0})</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Produit</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Qté</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>P.U.</th>
              <th style={{ textAlign: 'right', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(sale.details ?? []).map((d) => {
              const prod = products.find((p) => p.id === d.productId);
              return (
                <tr key={d.id}>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                    {prod ? `${prod.code} — ${prod.name}` : d.productId}
                  </td>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.quantity}</td>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatXAF(d.price)}</td>
                  <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatXAF(d.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 16px', display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151' }}>
          <span>TVA ({sale.taxRate ?? '0'} %)</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatXAF(sale.taxAmount ?? '0')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151' }}>
          <span>Remise</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>− {formatXAF(sale.discount ?? '0')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#374151' }}>
          <span>Frais de port</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatXAF(sale.shipping ?? '0')}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 700, paddingTop: 6, borderTop: '1px solid #e5e7eb' }}>
          <span>Total</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatXAF(sale.grandTotal)}</span>
        </div>
      </div>

      {sale.status === 'PENDING' && (
        <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
          <button
            onClick={onDelete}
            disabled={deleting}
            style={{
              padding: '10px 16px', borderRadius: 6, border: '1px solid #dc2626',
              background: '#fff', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 14,
              opacity: deleting ? 0.7 : 1,
            }}
          >
            {deleting ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function SalesPage() {
  const qc = useQueryClient();
  const { toasts, add: addToast, dismiss } = useToast();

  const [page, setPage] = useState(1);
  const limit = 20;
  const [filterClient, setFilterClient]     = useState('');
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [filterStatus, setFilterStatus]     = useState('');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [detailId, setDetailId]   = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; reference: string } | null>(null);

  const { data, isLoading, isError } = useSales(page, limit, filterClient, filterWarehouse, filterStatus, '');
  const { data: detail, isLoading: detailLoading } = useSaleDetail(detailId);
  const { data: clientData }    = useClients();
  const { data: warehouseData } = useWarehouses();
  const { data: productData }   = useProducts();

  const clients    = clientData?.data ?? [];
  const warehouses = warehouseData?.data ?? [];
  const products   = productData?.data ?? [];

  const createMutation = useCreateSale();
  const deleteMutation  = useDeleteSale();

  async function handleSave(payload: unknown) {
    try {
      const created = await createMutation.mutateAsync(payload);
      setSheetOpen(false);
      addToast(`Vente créée. Référence : ${created.reference}`);
    } catch {
      addToast("Erreur lors de l'enregistrement de la vente.", 'error');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteTarget(null);
      if (detailId === id) setDetailId(null);
      addToast('Vente supprimée.');
    } catch {
      addToast('Erreur lors de la suppression.', 'error');
    }
  }

  // ── État chargement ───────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <Skeleton height={32} width={220} />
          <Skeleton height={36} width={160} />
        </div>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{ marginBottom: 12 }}><Skeleton height={48} /></div>
        ))}
      </div>
    );
  }

  // ── État erreur ───────────────────────────────────────────────────────────
  if (isError) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <p style={{ color: '#dc2626', fontSize: 15, marginBottom: 12 }}>
          Impossible de charger les ventes.
        </p>
        <button
          onClick={() => void qc.invalidateQueries({ queryKey: ['sales'] })}
          style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
        >
          Réessayer
        </button>
      </div>
    );
  }

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto' }}>
      <style>{`@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }`}</style>

      {/* ── En-tête ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Ventes</h1>
        <button
          onClick={() => setSheetOpen(true)}
          style={{ padding: '9px 18px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
        >
          + Nouvelle vente
        </button>
      </div>

      {/* ── Filtres ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <select
          value={filterClient}
          onChange={(e) => { setFilterClient(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous les clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          value={filterWarehouse}
          onChange={(e) => { setFilterWarehouse(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous les entrepôts</option>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
        >
          <option value="">Tous les statuts</option>
          <option value="PENDING">En attente</option>
          <option value="COMPLETED">Terminée</option>
          <option value="CANCELLED">Annulée</option>
        </select>
      </div>

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '64px 0', color: '#6b7280' }}>
          <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Aucune vente</p>
          <p style={{ fontSize: 14, marginBottom: 20 }}>Créez votre première vente pour un client.</p>
          <button
            onClick={() => setSheetOpen(true)}
            style={{ padding: '9px 18px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontWeight: 600 }}
          >
            + Nouvelle vente
          </button>
        </div>
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              {['Référence', 'Date', 'Client', 'Entrepôt', 'Lignes', 'Total', 'Paiement', 'Statut', 'Actions'].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, color: '#374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const clientName    = clients.find((c) => c.id === s.clientId)?.name ?? '—';
              const warehouseName = warehouses.find((w) => w.id === s.warehouseId)?.name ?? '—';
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{s.reference}</td>
                  <td style={{ padding: '10px 12px' }}>{formatDate(s.date)}</td>
                  <td style={{ padding: '10px 12px' }}>{clientName}</td>
                  <td style={{ padding: '10px 12px' }}>{warehouseName}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>{s.details?.length ?? '—'}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatXAF(s.grandTotal)}</td>
                  <td style={{ padding: '10px 12px' }}><PaymentBadge status={s.paymentStatus} /></td>
                  <td style={{ padding: '10px 12px' }}><StatusBadge status={s.status} /></td>
                  <td style={{ padding: '10px 12px', display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => setDetailId(s.id)}
                      style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: 13 }}
                    >
                      Voir
                    </button>
                    {s.status === 'PENDING' && (
                      <button
                        onClick={() => setDeleteTarget({ id: s.id, reference: s.reference })}
                        style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #fca5a5', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}
                      >
                        Supprimer
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            ←
          </button>
          <span style={{ padding: '6px 10px', fontSize: 13 }}>{page} / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>
            →
          </button>
        </div>
      )}

      {/* ── Sheet création ───────────────────────────────────────────────── */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Nouvelle vente">
        <SaleForm
          clients={clients}
          warehouses={warehouses}
          products={products}
          onSave={(payload) => void handleSave(payload)}
          saving={createMutation.isPending}
        />
      </Sheet>

      {/* ── Sheet détail ─────────────────────────────────────────────────── */}
      <Sheet
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={detail ? `Vente ${detail.reference}` : 'Chargement…'}
      >
        {detailLoading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}
          </div>
        )}
        {detail && (
          <SaleDetailView
            sale={detail}
            products={products}
            onDelete={() => setDeleteTarget({ id: detail.id, reference: detail.reference })}
            deleting={deleteMutation.isPending}
          />
        )}
      </Sheet>

      {/* ── AlertDialog suppression ───────────────────────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        title={`Supprimer la vente ${deleteTarget?.reference ?? ''} ?`}
        description="Cette action est irréversible. La vente sera définitivement supprimée."
        confirmLabel="Supprimer"
        onConfirm={() => deleteTarget && void handleDelete(deleteTarget.id)}
        onCancel={() => setDeleteTarget(null)}
        loading={deleteMutation.isPending}
      />

      <ToastList toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
