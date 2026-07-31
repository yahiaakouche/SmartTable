import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { PinLockoutService } from './pin-lockout.service';
import { AUTH_REPOSITORY, DrizzleAuthRepository } from './auth.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';

/**
 * The auth domain owns everything about proving identity: credentials
 * (password/PIN hashes), the two-tier session model (Device Trust + acting
 * JWT), PIN lockout, and the two global guards that enforce NFR8 on every
 * route. Guard registration order matters: JwtAuthGuard (who are you?) must
 * run before PermissionsGuard (may you?).
 *
 * Exports are explicit and minimal (Engineering Standards §2) — other modules
 * consume identity services only through what is declared here.
 */
@Module({
  imports: [
    AuditModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // The install-time signing key comes from Electron safeStorage via
        // Host-provided config — never the DB, never a file (Security §4).
        secret: config.getOrThrow<string>('JWT_SIGNING_KEY'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    PinLockoutService,
    { provide: AUTH_REPOSITORY, useClass: DrizzleAuthRepository },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
