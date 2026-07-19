import { of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { AuditInterceptor } from '../audit.interceptor';
import { AuditService } from '../audit.service';
import type { ExecutionContext, CallHandler } from '@nestjs/common';

function makeContext(user?: unknown): ExecutionContext {
  return {
    getHandler: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: { id: 'entity-uuid-123' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeCallHandler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('AuditInterceptor', () => {
  let reflector: Reflector;
  let auditService: jest.Mocked<AuditService>;
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    auditService = {
      create: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditService>;
    interceptor = new AuditInterceptor(reflector, auditService);
  });

  it('ne cree pas AuditLog si @Auditable est absent', (done) => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    interceptor.intercept(makeContext(), makeCallHandler({ id: 'x' })).subscribe({
      complete: () => {
        expect(auditService.create).not.toHaveBeenCalled();
        done();
      },
    });
  });

  it('persiste un AuditLog apres la reponse du handler', (done) => {
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const user = { id: 'user-id', organizationId: 'org-id', email: 'a@b.com', isActive: true };
    const responseBody = { id: 'role-id', name: 'Admin' };

    interceptor.intercept(makeContext(user), makeCallHandler(responseBody)).subscribe({
      next: (val) => {
        expect(val).toEqual(responseBody);
      },
      complete: () => {
        setImmediate(() => {
          expect(auditService.create).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'roles.update',
              entity: 'Role',
              actorId: 'user-id',
              organizationId: 'org-id',
              entityId: 'role-id',
            }),
          );
          done();
        });
      },
    });
  });

  it('exclut les champs sensibles du champ after', (done) => {
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const user = { id: 'u', organizationId: 'o', email: 'x@y.com', isActive: true };
    const responseBody = { id: 'r', name: 'Admin', password: 'secret', token: 'tok' };

    interceptor.intercept(makeContext(user), makeCallHandler(responseBody)).subscribe({
      complete: () => {
        setImmediate(() => {
          const call = auditService.create.mock.calls[0]?.[0];
          expect(call?.after).not.toHaveProperty('password');
          expect(call?.after).not.toHaveProperty('token');
          expect(call?.after).toHaveProperty('name', 'Admin');
          done();
        });
      },
    });
  });

  it('un echec de persistence ne propage pas erreur au client', (done) => {
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue({ action: 'roles.update', entity: 'Role' });
    auditService.create.mockImplementation(() => Promise.reject(new Error('DB down')));
    const user = { id: 'u', organizationId: 'o', email: 'x@y.com', isActive: true };

    interceptor.intercept(makeContext(user), makeCallHandler({ id: 'r' })).subscribe({
      complete: () => {
        setImmediate(() => {
          done();
        });
      },
      error: (err: unknown) => {
        done(err);
      },
    });
  });

  it('passe-plat si le handler retourne une erreur', (done) => {
    jest
      .spyOn(reflector, 'get')
      .mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const handler: CallHandler = {
      handle: () => throwError(() => new Error('Not Found')),
    };

    interceptor.intercept(makeContext(), handler).subscribe({
      error: (err: unknown) => {
        expect((err as Error).message).toBe('Not Found');
        expect(auditService.create).not.toHaveBeenCalled();
        done();
      },
    });
  });
});
