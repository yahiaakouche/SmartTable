import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { EmployeeRole } from '@smarttable/shared-types';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ActingEmployee } from './decorators/current-employee.decorator';
import { AUTH_REPOSITORY, AuthRepository } from './auth.repository';
import { UnauthenticatedException } from '../../common/exceptions/domain.exception';

interface AccessTokenPayload {
  sub: string;
  name: string;
  role: EmployeeRole;
  type: string;
}

/**
 * Global authentication gate (NFR8 — enforced at the system level).
 * Every request must carry a valid 15-minute acting-employee JWT unless the
 * route is explicitly marked @Public(). The employee is re-loaded from the
 * database on every request so a deactivated account loses access immediately,
 * not whenever its last token happens to expire.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    @Inject(AUTH_REPOSITORY) private readonly authRepository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; employee?: ActingEmployee }>();
    const authorization = request.headers['authorization'];
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthenticatedException();

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_SIGNING_KEY'),
      });
    } catch {
      throw new UnauthenticatedException('Missing or expired access token.');
    }
    if (payload.type !== 'access') throw new UnauthenticatedException();

    const employee = await this.authRepository.findEmployeeById(payload.sub);
    if (!employee || !employee.isActive) throw new UnauthenticatedException();

    request.employee = { id: employee.id, name: employee.name, role: employee.role as EmployeeRole };
    return true;
  }
}
