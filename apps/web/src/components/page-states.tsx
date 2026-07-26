import React from 'react';
import { AlertTriangle, Inbox, type LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';

/**
 * Composants transverses pour la grammaire des 5 états obligatoires (standards.md règle 2) :
 * chargement, vide, erreur, partiel, succès. Chaque écran de liste compose PageHeader +
 * TableSkeleton|EmptyState|ErrorState|<table réelle>.
 */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-[22px] font-semibold text-neutral-900">{title}</h1>
        {description && <p className="mt-0.5 text-[13.5px] text-neutral-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-card border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 border-b border-neutral-100 px-4 py-3.5 last:border-0">
          {Array.from({ length: columns }).map((__, c) => (
            <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'w-28' : 'w-20')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-neutral-300 bg-white px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50">
        <Icon className="h-6 w-6 text-brand-500" strokeWidth={1.5} />
      </div>
      <p className="font-display text-[16px] font-semibold text-neutral-900">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-[13.5px] text-neutral-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message = 'Impossible de charger les données.',
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-danger-200 bg-danger-50 px-6 py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white">
        <AlertTriangle className="h-6 w-6 text-danger-600" strokeWidth={1.5} />
      </div>
      <p className="font-display text-[16px] font-semibold text-danger-700">{message}</p>
      <div className="mt-5">
        <Button variant="secondary" onClick={onRetry}>
          Réessayer
        </Button>
      </div>
    </div>
  );
}
