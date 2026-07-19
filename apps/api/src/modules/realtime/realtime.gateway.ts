import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

interface JwtPayload {
  sub: string;
  organizationId: string;
  email: string;
}

/**
 * Gateway Socket.io minimal — authentification JWT + rooms par organisation.
 *
 * Namespace : /realtime
 * À la connexion :
 *   - Extrait le Bearer token du handshake (auth.token ou Authorization header)
 *   - Valide via JwtService
 *   - Joint la room `org:<organizationId>` (isolation multi-tenant)
 *   - Déconnecte immédiatement en cas de token absent ou invalide
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: '*', credentials: true } })
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Branche le Redis adapter pour la diffusion multi-instance dès que le serveur est prêt.
   */
  afterInit(server: Server): void {
    const redisUrl = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const pub = new Redis(redisUrl);
    const sub = pub.duplicate();
    server.adapter(createAdapter(pub, sub));
    this.logger.log('Gateway Socket.io initialisee avec Redis adapter');
  }

  /**
   * Authentifie le client à la connexion.
   * Token extrait depuis : socket.handshake.auth.token  OU  Authorization: Bearer <token>
   */
  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = this.extractToken(socket);
      if (!token) {
        this.disconnect(socket, 'token manquant');
        return;
      }

      const secret = this.config.getOrThrow<string>('JWT_SECRET');
      const payload = this.jwt.verify<JwtPayload>(token, { secret });

      socket.data = { userId: payload.sub, organizationId: payload.organizationId };
      await socket.join(`org:${payload.organizationId}`);

      this.logger.debug(`Socket ${socket.id} authentifie — room org:${payload.organizationId}`);
    } catch {
      this.disconnect(socket, 'token invalide ou expire');
    }
  }

  handleDisconnect(socket: Socket): void {
    this.logger.debug(`Socket ${socket.id} deconnecte`);
  }

  // ─── Helpers privés ────────────────────────────────────────────────────────

  private extractToken(socket: Socket): string | null {
    const fromAuth = (socket.handshake.auth as Record<string, unknown>)['token'];
    if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

    const authHeader = socket.handshake.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  private disconnect(socket: Socket, reason: string): void {
    this.logger.warn(`Connexion refusee (${reason}) — socket ${socket.id}`);
    socket.disconnect(true);
  }
}
