import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

export interface ViewAllRequest extends Request {
  user: AuthenticatedUser;
  /** Injecté par ViewAllInterceptor avant l'exécution du handler. */
  viewAll: boolean;
}

/**
 * Interceptor transverse « records.viewAll ».
 *
 * Avant l'exécution du handler, vérifie si l'utilisateur possède la permission
 * `records.viewAll` dans son organisation et injecte `request.viewAll` en conséquence.
 *
 * Les services documentaires (Sales, Purchases, Quotations, Returns, Expenses) lisent
 * `request.viewAll` pour basculer entre :
 *   - true  → pas de filtre sur createdBy (l'utilisateur voit tous les documents)
 *   - false → WHERE createdBy = userId (l'utilisateur ne voit que ses propres documents)
 */
@Injectable()
export class ViewAllInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<ViewAllRequest>();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user) {
      request.viewAll = false;
      return next.handle();
    }

    const count = await this.prisma.permissionOnRole.count({
      where: {
        permission: { name: 'records.viewAll' },
        role: {
          organizationId: user.organizationId,
          users: { some: { userId: user.id } },
        },
      },
    });

    request.viewAll = count > 0;
    return next.handle();
  }
}
