import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface TenantStore {
  organizationId: string;
}

/** Contexte de requête tenant — alimenté par le middleware de résolution de sous-domaine. */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantStore>();

  /**
   * Exécute `fn` dans un contexte tenant isolé.
   * Appelé par le middleware après résolution du sous-domaine.
   */
  run<T>(organizationId: string, fn: () => T): T {
    return this.storage.run({ organizationId }, fn);
  }

  /**
   * Retourne l'organizationId du tenant courant.
   * Lève InternalServerErrorException si appelé hors contexte tenant — jamais silencieux.
   */
  getOrganizationId(): string {
    const store = this.storage.getStore();
    if (!store) {
      throw new InternalServerErrorException(
        'TenantContext non initialisé — le middleware tenant doit être appliqué sur cette route',
      );
    }
    return store.organizationId;
  }
}
