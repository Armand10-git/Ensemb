import React, { useRef } from 'react';
import { Printer } from 'lucide-react';
import { useReactToPrint } from 'react-to-print';
import { Button } from './ui/button';
import { formatXAF, formatDate } from '../lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PosReceiptPaymentMethod = 'CASH' | 'CARD' | 'MOBILE_MONEY';

export interface PosReceiptLine {
  productId: string;
  name: string;
  quantity: string;
  price: string;
  total: string;
}

export interface PosReceiptData {
  reference: string;
  date: string;
  clientName: string;
  lines: PosReceiptLine[];
  taxAmount: string;
  discount: string;
  grandTotal: string;
  paymentMethod: PosReceiptPaymentMethod;
  amountReceived?: string;
  change?: string;
}

const PAYMENT_METHOD_LABELS: Record<PosReceiptPaymentMethod, string> = {
  CASH: 'Espèces',
  CARD: 'Carte',
  MOBILE_MONEY: 'Mobile Money',
};

/**
 * Reçu de vente POS (§18.2 étape 8) : repli navigateur via react-to-print — l'impression
 * ESC/POS thermique réelle est hors périmètre S23 (§17 point D, cible P5).
 */
export function PosReceipt({ receipt }: { receipt: PosReceiptData }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef,
    documentTitle: `Reçu ${receipt.reference}`,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-neutral-700">Reçu de vente</p>
        <Button variant="secondary" size="sm" onClick={() => handlePrint()}>
          <Printer className="h-3.5 w-3.5" />
          Imprimer
        </Button>
      </div>

      <div ref={contentRef} className="rounded-card border border-neutral-200 bg-white p-4 font-mono text-[12.5px]">
        <p className="text-center font-semibold">Ensemb</p>
        <p className="text-center text-neutral-500">{formatDate(receipt.date)}</p>
        <p className="mt-2 tabular">Référence : {receipt.reference}</p>
        <p>Client : {receipt.clientName}</p>
        <div className="my-2 border-t border-dashed border-neutral-300" />
        {receipt.lines.map((l) => (
          <div key={l.productId} className="flex justify-between gap-2">
            <span className="truncate">{l.quantity} × {l.name}</span>
            <span className="tabular flex-shrink-0">{formatXAF(l.total)}</span>
          </div>
        ))}
        <div className="my-2 border-t border-dashed border-neutral-300" />
        <div className="flex justify-between"><span>TVA</span><span className="tabular">{formatXAF(receipt.taxAmount)}</span></div>
        <div className="flex justify-between"><span>Remise</span><span className="tabular">− {formatXAF(receipt.discount)}</span></div>
        <div className="mt-1 flex justify-between text-[14px] font-semibold"><span>Total</span><span className="tabular">{formatXAF(receipt.grandTotal)}</span></div>
        <div className="my-2 border-t border-dashed border-neutral-300" />
        <p>Paiement : {PAYMENT_METHOD_LABELS[receipt.paymentMethod]}</p>
        {receipt.paymentMethod === 'CASH' && receipt.amountReceived && (
          <>
            <div className="flex justify-between"><span>Reçu</span><span className="tabular">{formatXAF(receipt.amountReceived)}</span></div>
            <div className="flex justify-between"><span>Monnaie rendue</span><span className="tabular">{formatXAF(receipt.change ?? '0')}</span></div>
          </>
        )}
      </div>
    </div>
  );
}
