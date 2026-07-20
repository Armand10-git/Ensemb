import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  symbolPosition: 'BEFORE' | 'AFTER';
  decimalPlaces: number;
  isActive: boolean;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useCurrencies() {
  return useQuery<Currency[]>({
    queryKey: ['currencies'],
    queryFn: () => api.get<Currency[]>('/currencies'),
    staleTime: 60_000,
  });
}

function useDefaultCurrency() {
  return useQuery<{ defaultCurrencyId: string | null }>({
    queryKey: ['organization-default-currency'],
    queryFn: () => api.get<{ defaultCurrencyId: string | null }>('/organizations/me'),
    staleTime: 60_000,
  });
}

function useUpdateDefaultCurrency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (currencyId: string) =>
      api.patch('/organizations/default-currency', { currencyId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['organization-default-currency'] });
    },
  });
}

// ─── Composants ──────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      {[1, 2, 3, 4, 5, 6].map((i) => (
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

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-500">
      <p className="text-lg font-medium">Aucune devise disponible</p>
      <p className="mt-1 text-sm">Les devises sont gérées par l'administrateur de la plateforme.</p>
    </div>
  );
}

// ─── Écran principal ─────────────────────────────────────────────────────────

export function CurrenciesPage() {
  const { data: currencies, isLoading, isError, error, refetch } = useCurrencies();
  const { data: orgData } = useDefaultCurrency();
  const updateDefault = useUpdateDefaultCurrency();
  const [selectedCurrencyId, setSelectedCurrencyId] = useState<string>('');

  const currentDefaultId = orgData?.defaultCurrencyId ?? '';

  function handleSetDefault() {
    if (!selectedCurrencyId || selectedCurrencyId === currentDefaultId) return;
    updateDefault.mutate(selectedCurrencyId);
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-gray-900">Devises</h1>

      {/* Sélecteur de devise par défaut */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-700">Devise par défaut de l'organisation</h2>
        <div className="flex items-center gap-3">
          <select
            data-testid="default-currency-select"
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={selectedCurrencyId || currentDefaultId}
            onChange={(e) => setSelectedCurrencyId(e.target.value)}
            disabled={isLoading}
          >
            {!isLoading && currencies?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
          <button
            data-testid="save-default-currency"
            onClick={handleSetDefault}
            disabled={updateDefault.isPending || !selectedCurrencyId || selectedCurrencyId === currentDefaultId}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {updateDefault.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
        {updateDefault.isError && (
          <p className="mt-2 text-sm text-red-600">
            {(updateDefault.error as Error).message}
          </p>
        )}
        {updateDefault.isSuccess && (
          <p className="mt-2 text-sm text-green-600">Devise par défaut mise à jour.</p>
        )}
      </div>

      {/* État erreur */}
      {isError && (
        <ErrorBanner
          message={(error as Error).message ?? 'Impossible de charger les devises.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* Tableau */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {['Code', 'Nom', 'Symbole', 'Position', 'Décimales', 'Actif'].map((h) => (
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
            {/* État chargement — 3 lignes skeleton */}
            {isLoading &&
              [1, 2, 3].map((i) => <SkeletonRow key={i} />)}

            {/* État succès */}
            {!isLoading && !isError && currencies?.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono font-semibold text-gray-900">{c.code}</td>
                <td className="px-4 py-3 text-gray-700">{c.name}</td>
                <td className="px-4 py-3 text-gray-700">{c.symbol}</td>
                <td className="px-4 py-3 text-gray-500">
                  {c.symbolPosition === 'BEFORE' ? 'Avant le montant' : 'Après le montant'}
                </td>
                <td className="px-4 py-3 tabular-nums text-right text-gray-700">{c.decimalPlaces}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      c.isActive
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {c.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* État vide */}
        {!isLoading && !isError && (!currencies || currencies.length === 0) && <EmptyState />}
      </div>

      {/* État partiel */}
      {!isLoading && !isError && currencies && currencies.length > 0 && (
        <p className="text-right text-xs text-gray-400">
          {currencies.length} devise{currencies.length > 1 ? 's' : ''} chargée{currencies.length > 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}

export default CurrenciesPage;
