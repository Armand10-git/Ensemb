import { of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { AuditInterceptor } from '../audit.interceptor';
import { AuditService } from '../audit.service';
import type { ExecutionContext, CallHandler } from '@nestjs/common';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ROLE_UUID  = '660e8400-e29b-41d4-a716-446655440001';
const USER_UUID  = '770e8400-e29b-41d4-a716-446655440002';
const ORG_UUID   = '880e8400-e29b-41d4-a716-446655440003';

function makeContext(user?: unknown, paramId?: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        params: { id: paramId ?? VALID_UUID },
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeCallHandler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

/** Attend que toutes les microtasks et macrotasks immédiates se résolvent. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AuditInterceptor', () => {
  let reflector: Reflector;
  let auditService: jest.Mocked<Pick<AuditService, 'create' | 'fetchEntitySnapshot'>>;
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    reflector = new Reflector();
    auditService = {
      create: jest.fn().mockResolvedValue(undefined),
      fetchEntitySnapshot: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Pick<AuditService, 'create' | 'fetchEntitySnapshot'>>;
    interceptor = new AuditInterceptor(reflector, auditService as unknown as AuditService);
  });

  it('ne cree pas AuditLog si @Auditable est absent', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(), makeCallHandler({ id: ROLE_UUID })).subscribe({
        complete: resolve,
      });
    });
    expect(auditService.create).not.toHaveBeenCalled();
  });

  it('persiste un AuditLog avec actorId, organizationId, entityId corrects', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };
    const responseBody = { id: ROLE_UUID, name: 'Admin' };

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler(responseBody)).subscribe({
        complete: resolve,
      });
    });
    await flush();

    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'roles.update',
        entity: 'Role',
        actorId: USER_UUID,
        organizationId: ORG_UUID,
        entityId: ROLE_UUID,
        actorType: 'USER',
      }),
    );
  });

  it('capture le champ before via fetchEntitySnapshot', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const beforeState = { id: VALID_UUID, name: 'OldName', isActive: true };
    auditService.fetchEntitySnapshot.mockResolvedValue(beforeState);
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler({ id: ROLE_UUID, name: 'NewName' })).subscribe({
        complete: resolve,
      });
    });
    await flush();

    const call = auditService.create.mock.calls[0]?.[0];
    expect(call?.before).toEqual({ id: VALID_UUID, name: 'OldName', isActive: true });
    expect(auditService.fetchEntitySnapshot).toHaveBeenCalledWith('Role', VALID_UUID);
  });

  it('before est null si fetchEntitySnapshot echoue (requete non bloquee)', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    auditService.fetchEntitySnapshot.mockRejectedValue(new Error('DB timeout'));
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };

    await new Promise<void>((resolve, reject) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler({ id: ROLE_UUID })).subscribe({
        complete: resolve,
        error: reject,
      });
    });
    await flush();

    const call = auditService.create.mock.calls[0]?.[0];
    expect(call?.before).toBeNull();
  });

  it('cas 204 : entityId tombe sur req.params.id quand body est undefined', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.delete', entity: 'Role' });
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler(undefined)).subscribe({
        complete: resolve,
      });
    });
    await flush();

    const call = auditService.create.mock.calls[0]?.[0];
    expect(call?.entityId).toBe(VALID_UUID);
    expect(call?.after).toBeNull();
  });

  it('actorType = SYSTEM et organizationId = null quand user est absent', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(undefined, VALID_UUID), makeCallHandler({ id: ROLE_UUID })).subscribe({
        complete: resolve,
      });
    });
    await flush();

    expect(auditService.create).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'SYSTEM', organizationId: null, actorId: null }),
    );
  });

  it('exclut les champs sensibles de after (top-level)', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };
    const responseBody = { id: ROLE_UUID, name: 'Admin', password: 'secret', token: 'tok' };

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler(responseBody)).subscribe({
        complete: resolve,
      });
    });
    await flush();

    const call = auditService.create.mock.calls[0]?.[0];
    expect(call?.after).not.toHaveProperty('password');
    expect(call?.after).not.toHaveProperty('token');
    expect(call?.after).toHaveProperty('name', 'Admin');
  });

  it('exclut les champs sensibles de after (objets imbriques)', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };
    const responseBody = { id: ROLE_UUID, user: { name: 'Bob', passwordHash: 'hash' } };

    await new Promise<void>((resolve) => {
      interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler(responseBody)).subscribe({
        complete: resolve,
      });
    });
    await flush();

    const call = auditService.create.mock.calls[0]?.[0];
    const after = call?.after as Record<string, unknown>;
    const nested = after?.['user'] as Record<string, unknown>;
    expect(nested).not.toHaveProperty('passwordHash');
    expect(nested).toHaveProperty('name', 'Bob');
  });

  it('un echec de persistence ne propage pas erreur au client', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    auditService.create.mockImplementation(() => Promise.reject(new Error('DB down')));
    const user = { id: USER_UUID, organizationId: ORG_UUID, email: 'a@b.com', isActive: true };

    await expect(
      new Promise<void>((resolve, reject) => {
        interceptor.intercept(makeContext(user, VALID_UUID), makeCallHandler({ id: ROLE_UUID })).subscribe({
          complete: resolve,
          error: reject,
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('passe-plat si le handler retourne une erreur HTTP', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });
    const handler: CallHandler = { handle: () => throwError(() => new Error('Not Found')) };

    await expect(
      new Promise<void>((_, reject) => {
        interceptor.intercept(makeContext(), handler).subscribe({ error: reject });
      }),
    ).rejects.toThrow('Not Found');

    expect(auditService.create).not.toHaveBeenCalled();
  });

  it('ignore un paramId non-UUID (pas de fetchEntitySnapshot)', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue({ action: 'roles.update', entity: 'Role' });

    await new Promise<void>((resolve) => {
      // paramId est "not-a-uuid" — ne doit pas déclencher fetchEntitySnapshot
      interceptor.intercept(makeContext(undefined, 'not-a-uuid'), makeCallHandler({ id: ROLE_UUID })).subscribe({
        complete: resolve,
      });
    });
    await flush();

    expect(auditService.fetchEntitySnapshot).not.toHaveBeenCalled();
  });
});
