import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, Observable, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { AUDITABLE_KEY, type AuditableMetadata } from './auditable.decorator';
import { AuditService } from './audit.service';
import type { AuthenticatedRequest } from '../auth/types/authenticated-request';
import type { Prisma } from '@prisma/client';

/** L'interceptor s'applique aussi sur des routes publiques sans user. */
type MaybeAuthRequest = Request & Partial<Pick<AuthenticatedRequest, 'user'>>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Interceptor global branché via APP_INTERCEPTOR.
 * Se déclenche uniquement sur les handlers décorés par @Auditable.
 *
 * Flux :
 *  1. Lecture de l'entité avant la mutation (champ `before`) si un :id est présent.
 *  2. Exécution du handler.
 *  3. Persistence asynchrone (fire-and-forget) de l'AuditLog avec before + after.
 *
 * Un échec à n'importe quelle étape de l'audit n'impacte jamais le client.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.get<AuditableMetadata | undefined>(
      AUDITABLE_KEY,
      context.getHandler(),
    );

    if (!metadata) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<MaybeAuthRequest>();
    const user = req.user;
    const paramId = req.params['id'] as string | undefined;
    const validParamId = paramId && UUID_REGEX.test(paramId) ? paramId : undefined;

    // Lecture pre-mutation — absorbée si le modèle n'existe pas ou si DB en erreur
    const before$ = validParamId
      ? from(this.auditService.fetchEntitySnapshot(metadata.entity, validParamId)).pipe(
          catchError(() => of(null)),
        )
      : of(null);

    return before$.pipe(
      switchMap((beforeState) =>
        next.handle().pipe(
          tap((responseBody: unknown) => {
            const entityId =
              extractEntityId(responseBody) ?? validParamId ?? null;

            // Fire-and-forget : .catch() obligatoire pour éviter une unhandledRejection dans RxJS
            void this.auditService
              .create({
                organizationId: user?.organizationId ?? null,
                actorType: user ? 'USER' : 'SYSTEM',
                actorId: user?.id ?? null,
                action: metadata.action,
                entity: metadata.entity,
                entityId,
                before: sanitize(beforeState),
                after: sanitize(responseBody),
              })
              .catch(() => {
                // Deja logge dans AuditService.create
              });
          }),
        ),
      ),
    );
  }
}

/**
 * Extrait l'id UUID d'une ressource depuis le corps de la réponse.
 * Inspecte en priorité `id`, puis les champs `*Id` courants pour les endpoints
 * de création qui ne renvoient pas de champ `id` canonique (ex. register → organizationId).
 * Valide le format UUID pour ne pas persister un id malformé.
 */
function extractEntityId(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of ['id', 'organizationId', 'userId', 'roleId']) {
    const val = obj[key];
    if (typeof val === 'string' && UUID_REGEX.test(val)) return val;
  }
  return undefined;
}

const FORBIDDEN = new Set([
  'password',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'token',
  'secret',
]);

/**
 * Supprime récursivement les champs sensibles avant persistence.
 * Gère les objets imbriqués et les tableaux.
 * Le cast final vers InputJsonValue est safe : la valeur est un plain JSON.
 */
function sanitize(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    return value.map(sanitize) as Prisma.InputJsonValue;
  }

  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!FORBIDDEN.has(k)) {
        result[k] = sanitize(v);
      }
    }
    return result as Prisma.InputJsonValue;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}
