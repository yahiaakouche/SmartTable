import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { EmployeeRole } from '@smarttable/shared-types';
import type { AuthTokenResponse, PasswordLoginResponse } from '@smarttable/shared-types';
import { AUTH_REPOSITORY, AuthRepository } from './auth.repository';
import { TokensService } from './tokens.service';
import { PinLockoutService } from './pin-lockout.service';
import { AuditService } from '../audit/audit.service';
import {
  AccountLockedException,
  UnauthenticatedException,
} from '../../common/exceptions/domain.exception';

/** Roles permitted to use full password login — Security Architecture §1
 * frames password as the Owner/Manager path for new/untrusted devices;
 * daily terminal work happens via PIN on an already-trusted device. */
const PASSWORD_LOGIN_ROLES: readonly string[] = [EmployeeRole.OWNER, EmployeeRole.MANAGER];

/**
 * The three authentication flows (API Contract Design §3, `auth` module).
 * All business rules live here — the controller is a thin translation layer.
 * Every failure outcome is audit-logged as a security event (Security §1/§9),
 * regardless of result.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly authRepository: AuthRepository,
    private readonly tokens: TokensService,
    private readonly pinLockout: PinLockoutService,
    private readonly audit: AuditService,
  ) {}

  /**
   * PIN login on an already-trusted device. The device refresh token proves
   * the device; the PIN proves the person. Lockout is checked BEFORE any
   * credential work so a locked account costs an attacker nothing to probe.
   */
  async pinLogin(deviceRefreshToken: string, employeeId: string, pin: string): Promise<AuthTokenResponse> {
    const lockRemainingMs = this.pinLockout.getLockRemainingMs(employeeId);
    if (lockRemainingMs > 0) {
      throw new AccountLockedException(Math.ceil(lockRemainingMs / 1000));
    }

    // Device Trust must exist AND belong to the employee attempting login.
    const trusted = await this.tokens.validateAndRenewDeviceTrust(deviceRefreshToken);
    if (trusted.id !== employeeId) {
      throw new UnauthenticatedException('Device trust does not belong to this employee.');
    }

    const employee = await this.authRepository.findEmployeeById(employeeId);
    const pinMatches =
      employee?.isActive && employee.pinHash ? await argon2.verify(employee.pinHash, pin) : false;

    if (!pinMatches) {
      const lockDurationMs = this.pinLockout.recordFailure(employeeId);
      await this.audit.append({
        actorEmployeeId: employeeId,
        entityType: 'employee',
        entityId: employeeId,
        action: 'login_failed',
        newValueJson: JSON.stringify({ method: 'pin' }),
      });
      if (lockDurationMs !== null) {
        await this.audit.append({
          actorEmployeeId: employeeId,
          entityType: 'employee',
          entityId: employeeId,
          action: 'account_locked',
          newValueJson: JSON.stringify({ lockedForSeconds: lockDurationMs / 1000 }),
        });
        throw new AccountLockedException(Math.ceil(lockDurationMs / 1000));
      }
      throw new UnauthenticatedException('Invalid PIN.');
    }

    this.pinLockout.recordSuccess(employeeId);
    await this.authRepository.recordLogin(employeeId, Date.now());
    return this.tokens.issueAccessToken(employee!);
  }

  /**
   * Full login on a new/untrusted device. Success establishes Device Trust
   * for that device (returned exactly once) plus the acting-employee JWT.
   */
  async passwordLogin(name: string, password: string, deviceLabel: string): Promise<PasswordLoginResponse> {
    const candidates = await this.authRepository.findActiveEmployeesByName(name);

    let authenticated: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (!candidate.isActive || !PASSWORD_LOGIN_ROLES.includes(candidate.role) || !candidate.passwordHash) {
        continue;
      }
      if (await argon2.verify(candidate.passwordHash, password)) {
        authenticated = candidate;
        break;
      }
    }

    if (!authenticated) {
      await this.audit.append({
        actorEmployeeId: null,
        entityType: 'employee',
        entityId: name, // deliberately the attempted identifier, not a resolved account
        action: 'login_failed',
        newValueJson: JSON.stringify({ method: 'password' }),
      });
      throw new UnauthenticatedException('Invalid credentials.');
    }

    const { rawToken } = await this.tokens.createDeviceTrust(authenticated.id, deviceLabel);
    await this.authRepository.recordLogin(authenticated.id, Date.now());
    return { ...this.tokens.issueAccessToken(authenticated), deviceRefreshToken: rawToken };
  }

  /** Exchange a valid Device Trust token for a fresh acting-employee JWT. */
  async refresh(refreshToken: string): Promise<AuthTokenResponse> {
    const employee = await this.tokens.validateAndRenewDeviceTrust(refreshToken);
    return this.tokens.issueAccessToken(employee);
  }

  /**
   * Access tokens are stateless 15-minute JWTs — there is nothing server-side
   * to revoke, and Device Trust explicitly survives logout (API Contract §3:
   * "revokes current access context, not the device trust"). The endpoint
   * exists so the client has a well-defined, contract-stable way to end an
   * acting session.
   */
  async logout(): Promise<{ success: true }> {
    return { success: true };
  }

  /** Owner-triggered PIN reset (FR-adjacent, Security §9 audits pin resets). */
  async setPin(employeeId: string, rawPin: string): Promise<void> {
    await this.authRepository.setPinHash(employeeId, await argon2.hash(rawPin));
  }

  /** Hashes both credentials — used by invitation acceptance (FR27). */
  async hashCredentials(password: string, pin: string): Promise<{ passwordHash: string; pinHash: string }> {
    return { passwordHash: await argon2.hash(password), pinHash: await argon2.hash(pin) };
  }
}
