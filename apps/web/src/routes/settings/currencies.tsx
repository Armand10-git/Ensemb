import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import { NativeSelect } from '../../components/ui/native-select';
import { Badge } from '../../components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/table';
import { PageHeader, TableSkeleton, EmptyState, ErrorState } from '../../components/page-states';

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

// ─── Écran principal ─────────────────────────────────────────────────────────

/**
 * Écran de gestion des devises. Les devises elles-mêmes sont en lecture seule
 * (gérées par la plateforme) — seule la devise par défaut de l'organisation
 * est modifiable ici, via PATCH /organizations/default-currency.
 */
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
    <div className="mx-auto max-w-6xl p-8">
      <PageHeader
        title="Devises"
        description="Devises disponibles pour l'organisation — gérées par l'administrateur de la plateforme."
      />

      {/* ── Devise par défaut ───────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-[15px]">Devise par défaut de l'organisation</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="min-w-[14rem] space-y-1.5">
              <Label htmlFor="default-currency">Devise</Label>
              <NativeSelect
                id="default-currency"
                data-testid="default-currency-select"
                value={selectedCurrencyId || currentDefaultId}
                onChange={(e) => setSelectedCurrencyId(e.target.value)}
                disabled={isLoading}
              >
                {!isLoading && currencies?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              data-testid="save-default-currency"
              onClick={handleSetDefault}
              disabled={updateDefault.isPending || !selectedCurrencyId || selectedCurrencyId === currentDefaultId}
              loading={updateDefault.isPending}
            >
              {!updateDefault.isPending && 'Enregistrer'}
            </Button>
          </div>
          {updateDefault.isError && (
            <p className="mt-2 text-[13px] text-danger-600">{(updateDefault.error as Error).message}</p>
          )}
          {updateDefault.isSuccess && (
            <p className="mt-2 text-[13px] text-brand-700">Devise par défaut mise à jour.</p>
          )}
        </CardContent>
      </Card>

      {/* ── État chargement ───────────────────────────────────────────────── */}
      {isLoading && <TableSkeleton columns={6} />}

      {/* ── État erreur ───────────────────────────────────────────────────── */}
      {isError && (
        <ErrorState
          message={(error as Error).message || 'Impossible de charger les devises.'}
          onRetry={() => void refetch()}
        />
      )}

      {/* ── État vide ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && currencies && currencies.length === 0 && (
        <EmptyState
          icon={Coins}
          title="Aucune devise disponible"
          description="Les devises sont gérées par l'administrateur de la plateforme."
        />
      )}

      {/* ── Liste ────────────────────────────────────────────────────────── */}
      {!isLoading && !isError && currencies && currencies.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Nom</TableHead>
                <TableHead>Symbole</TableHead>
                <TableHead>Position</TableHead>
                <TableHead className="text-right">Décimales</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currencies.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="tabular font-semibold text-neutral-900">{c.code}</TableCell>
                  <TableCell>{c.name}</TableCell>
                  <TableCell>{c.symbol}</TableCell>
                  <TableCell className="text-neutral-500">
                    {c.symbolPosition === 'BEFORE' ? 'Avant le montant' : 'Après le montant'}
                  </TableCell>
                  <TableCell className="tabular text-right">{c.decimalPlaces}</TableCell>
                  <TableCell>
                    <Badge variant={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Active' : 'Inactive'}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* ── État partiel ─────────────────────────────────────────────── */}
          <p className="mt-3 text-right text-[12px] text-neutral-400">
            {currencies.length} devise{currencies.length > 1 ? 's' : ''} chargée{currencies.length > 1 ? 's' : ''}
          </p>
        </>
      )}
    </div>
  );
}

export default CurrenciesPage;
