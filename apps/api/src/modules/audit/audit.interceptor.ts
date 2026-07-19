import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { AUDITABLE_KEY, type AuditableMetadata } from './auditable.decorator';
import { AuditService } from './audit.service';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Prisma } from '@prisma/client';

interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Interceptor global branché via APP_INTERCEPTOR.
 * Se déclenche uniquement sur les handlers décorés par @Auditable.
 * La persistence est lancée en fire-and-forget après la réponse —
 * un échec n'impacte jamais le client.
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

    const req = context.switchToHttp().getRequest<AuthRequest>();
    const user = req.user;

    return next.handle().pipe(
      tap((responseBody: unknown) => {
        // Extraction de l'entityId : prefer l'id dans la réponse, sinon le param de route
        const entityId = extractEntityId(responseBody) ?? (req.params['id'] as string | undefined);

        // Lancement asynchrone — on ne await pas intentionnellement
        // Le .catch est obligatoire : une rejection void non catchée remonte dans RxJS
        void this.auditService
          .create({
            organizationId: user?.organizationId ?? null,
            actorType: user ? 'USER' : 'SYSTEM',
            actorId: user?.id ?? null,
            action: metadata.action,
            entity: metadata.entity,
            entityId: entityId ?? null,
            after: sanitize(responseBody),
          })
          .catch(() => {
            // Déjà loggé dans AuditService.create — on absorbe ici pour ne jamais impacter le client
          });
      }),
    );
  }
}

/**
 * Extrait l'id de la ressource depuis le corps de la réponse si disponible.
 */
function extractEntityId(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'id' in body) {
    const id = (body as Record<string, unknown>)['id'];
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/**
 * Supprime les champs sensibles avant persistence (pas de password, token…).
 * Le cast final est safe car un objet JSON plain satisfait InputJsonValue.
 */
function sanitize(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;

  const FORBIDDEN = new Set(['password', 'passwordHash', 'refreshToken', 'accessToken', 'token', 'secret']);
  const result: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!FORBIDDEN.has(k)) {
      result[k] = v;
    }
  }
  return result as Prisma.InputJsonValue;
}
