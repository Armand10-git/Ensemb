import type { Request } from 'express';
import type { AuthenticatedUser } from '../strategies/jwt.strategy';

/** Request Express avec l'utilisateur résolu par JwtStrategy — utiliser partout où @Req() est annoté. */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
