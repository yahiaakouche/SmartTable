import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  AuthTokenResponse,
  PasswordLoginResponse,
} from '@smarttable/shared-types';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { PinLoginDto } from './dto/pin-login.dto';
import { PasswordLoginDto } from './dto/password-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

/**
 * Thin translation layer only (Engineering Standards §3) — every rule lives
 * in AuthService. Rate limits per Security Architecture §5: login endpoints
 * get the strict 5/minute class, the primary network-level defense against
 * PIN brute-forcing on top of account lockout.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('pin-login')
  pinLogin(@Body() dto: PinLoginDto): Promise<AuthTokenResponse> {
    return this.authService.pinLogin(dto.deviceRefreshToken, dto.employeeId, dto.pin);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password-login')
  passwordLogin(@Body() dto: PasswordLoginDto): Promise<PasswordLoginResponse> {
    return this.authService.passwordLogin(dto.name, dto.password, dto.deviceLabel);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokenResponse> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  logout(): Promise<{ success: true }> {
    return this.authService.logout();
  }
}
