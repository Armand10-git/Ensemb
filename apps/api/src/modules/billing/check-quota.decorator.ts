import { SetMetadata } from '@nestjs/common';

export type QuotaResource = 'users' | 'warehouses' | 'products';

export const QUOTA_RESOURCE_KEY = 'quotaResource';

/** Protège un endpoint en vérifiant le quota de la ressource avant la création. */
export const CheckQuota = (resource: QuotaResource) =>
  SetMetadata(QUOTA_RESOURCE_KEY, resource);
