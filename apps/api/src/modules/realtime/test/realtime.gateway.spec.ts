import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RealtimeGateway } from '../realtime.gateway';
import type { Socket } from 'socket.io';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = { sub: 'user-uuid', organizationId: 'org-uuid', email: 'admin@demo.cm' };

const makeJwt = (payload: unknown | null) =>
  ({
    verify: jest.fn().mockImplementation(() => {
      if (payload === null) throw new Error('invalid token');
      return payload;
    }),
  }) as unknown as JwtService;

const makeConfig = () =>
  ({ get: jest.fn().mockReturnValue('redis://localhost:6379'), getOrThrow: jest.fn().mockReturnValue('test-secret') }) as unknown as ConfigService;

const makeSocket = (token?: string): Socket & { data: Record<string, unknown> } => {
  const joinMock = jest.fn().mockResolvedValue(undefined);
  const disconnectMock = jest.fn();
  return {
    id: 'socket-id',
    data: {},
    handshake: {
      auth: token ? { token } : {},
      headers: {},
    },
    join: joinMock,
    disconnect: disconnectMock,
  } as unknown as Socket & { data: Record<string, unknown> };
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RealtimeGateway', () => {
  describe('handleConnection', () => {
    it("joint la room org:<organizationId> avec un token valide", async () => {
      const gateway = new RealtimeGateway(makeJwt(VALID_PAYLOAD), makeConfig());
      const socket = makeSocket('valid.jwt.token');

      await gateway.handleConnection(socket);

      expect(socket.join).toHaveBeenCalledWith('org:org-uuid');
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.data).toMatchObject({ userId: 'user-uuid', organizationId: 'org-uuid' });
    });

    it('deconnecte immediatement si le token est absent', async () => {
      const gateway = new RealtimeGateway(makeJwt(VALID_PAYLOAD), makeConfig());
      const socket = makeSocket(); // pas de token

      await gateway.handleConnection(socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('deconnecte immediatement si le token est invalide', async () => {
      const gateway = new RealtimeGateway(makeJwt(null), makeConfig());
      const socket = makeSocket('invalid.token');

      await gateway.handleConnection(socket);

      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('extrait le token depuis Authorization: Bearer header', async () => {
      const gateway = new RealtimeGateway(makeJwt(VALID_PAYLOAD), makeConfig());
      const socket = makeSocket();
      // Injecte le token dans le header Authorization plutot que dans auth.token
      (socket.handshake as { headers: Record<string, string> }).headers['authorization'] =
        'Bearer valid.jwt.token';

      await gateway.handleConnection(socket);

      expect(socket.join).toHaveBeenCalledWith('org:org-uuid');
    });

    it('isole les tenants : deux orgs differentes = deux rooms differentes', async () => {
      const gateway = new RealtimeGateway(makeJwt(VALID_PAYLOAD), makeConfig());

      const socketA = makeSocket('token-a');
      const socketB = makeSocket('token-b');

      const jwtB = makeJwt({ ...VALID_PAYLOAD, organizationId: 'org-autre' });
      const gatewayB = new RealtimeGateway(jwtB, makeConfig());

      await gateway.handleConnection(socketA);
      await gatewayB.handleConnection(socketB);

      expect(socketA.join).toHaveBeenCalledWith('org:org-uuid');
      expect(socketB.join).toHaveBeenCalledWith('org:org-autre');
    });
  });
});
