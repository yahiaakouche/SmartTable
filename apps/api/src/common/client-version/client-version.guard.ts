import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ClientVersionStaleException } from '../exceptions/domain.exception';

/**
 * Client/server version mismatch enforcement — API Contract Design §1:
 * "X-Client-Version header checked on every request; mismatch returns
 * 409 CLIENT_VERSION_STALE prompting a refresh — relevant mainly to cached
 * customer QR pages." Step 3.14.
 *
 * Rulings baked in:
 *  - B4(a): implemented as a global APP_GUARD (not middleware) so the
 *    rejection flows through GlobalExceptionFilter's DomainException path
 *    and produces the frozen error envelope — exactly like every other 409.
 *  - B5(a): registered FIRST in the guard chain (before throttling and
 *    auth) — the cheapest possible rejection, and the refresh signal
 *    reaches a stale client before any other check runs.
 *  - B3(a): requests WITHOUT the header pass unchecked — backward
 *    compatible with the Host's diagnostics polling, Swagger, and support
 *    tooling; only clients that declare a version are held to it.
 *  - B2(a): exact string equality after trimming (D2) — any difference,
 *    older or newer, is "stale" (R2: refreshing always converges).
 *
 * The header is never trusted for anything else: not auth, not routing —
 * a forged value can only earn its sender a 409. WebSocket connections are
 * out of scope by ruling (the staff UI is bundled with the server in the
 * same installation, so skew there is impossible by construction).
 */
@Injectable()
export class ClientVersionGuard implements CanActivate {
  private readonly serverVersion: string;

  constructor(config: ConfigService) {
    this.serverVersion = config.getOrThrow<string>('APP_VERSION');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-client-version'];
    const clientVersion = (Array.isArray(header) ? header[0] : header)?.trim();

    if (clientVersion === undefined || clientVersion === this.serverVersion) {
      return true;
    }
    throw new ClientVersionStaleException();
  }
}
