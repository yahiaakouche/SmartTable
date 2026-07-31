import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import type { AuthTokenResponse, DeviceDto } from '@smarttable/shared-types';
import { AUTH_REPOSITORY, AuthRepository } from './auth.repository';
import { UnauthenticatedException } from '../../common/exceptions/domain.exception';

interface EmployeeIdentity {
  id: string;
  name: string;
  role: string;
}

/**
 * Owns the two-tier session model (Security Architecture §1, ADR-018):
 *  - Device Trust: opaque, cryptographically random refresh token (30 days,
 *    renewable on use), stored ONLY as a SHA-256 hash — the raw token is
 *    returned to the device exactly once and is never persisted.
 *  - Acting Employee Context: 15-minute JWT signed with the install-time key
 *    the Host supplies from Electron safeStorage (never the DB, never a file).
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @Inject(AUTH_REPOSITORY) private readonly authRepository: AuthRepository,
  ) {}

  issueAccessToken(employee: EmployeeIdentity): AuthTokenResponse {
    const expiresInSeconds = this.config.get<number>('JWT_ACCESS_TTL_SECONDS', 900);
    const accessToken = this.jwtService.sign(
      { sub: employee.id, name: employee.name, role: employee.role, type: 'access' },
      { expiresIn: expiresInSeconds },
    );
    return {
      accessToken,
      expiresInSeconds,
      employee: { id: employee.id, name: employee.name, role: employee.role as AuthTokenResponse['employee']['role'] },
    };
  }

  /** Verifies an acting-employee access token OUTSIDE the HTTP guard chain —
   * the Socket.IO handshake path (Step 3.5, ruling D2), where guards do not
   * run. Mirrors JwtAuthGuard exactly: same signing key, `type === 'access'`,
   * and a fresh DB reload so a deactivated employee cannot connect rather
   * than merely failing their next REST call. */
  async verifyAccessToken(token: string): Promise<EmployeeIdentity> {
    let payload: { sub: string; type: string };
    try {
      payload = await this.jwtService.verifyAsync<{ sub: string; type: string }>(token, {
        secret: this.config.getOrThrow<string>('JWT_SIGNING_KEY'),
      });
    } catch {
      throw new UnauthenticatedException('Missing or expired access token.');
    }
    if (payload.type !== 'access') throw new UnauthenticatedException();
    const employee = await this.authRepository.findEmployeeById(payload.sub);
    if (!employee || !employee.isActive) throw new UnauthenticatedException();
    return employee;
  }

  /** Prepares a new Device Trust row without persisting it — callers that need
   * transactional insertion (invitation acceptance) use this, then return the
   * raw token to the client exactly once. */
  generateDeviceTrustMaterial(employeeId: string, deviceLabel: string) {
    const rawToken = randomBytes(48).toString('base64url');
    const now = Date.now();
    return {
      rawToken,
      row: {
        employeeId,
        deviceLabel,
        tokenHash: TokensService.hashToken(rawToken),
        lastUsedAt: now,
        expiresAt: now + this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30) * 86_400_000,
      },
    };
  }

  /** Non-transactional variant for flows that only create Device Trust. */
  async createDeviceTrust(employeeId: string, deviceLabel: string): Promise<{ rawToken: string }> {
    const material = this.generateDeviceTrustMaterial(employeeId, deviceLabel);
    await this.authRepository.insertRefreshToken(material.row);
    return { rawToken: material.rawToken };
  }

  /** Validates a presented refresh token; on success renews it (30 days,
   * renewable on use — Security §1) and returns the owning employee. */
  async validateAndRenewDeviceTrust(rawToken: string): Promise<EmployeeIdentity> {
    const row = await this.authRepository.findRefreshTokenByHash(TokensService.hashToken(rawToken));
    if (!row || row.revokedAt !== null || row.expiresAt <= Date.now()) {
      throw new UnauthenticatedException('Device is not trusted. Full login required.');
    }
    const now = Date.now();
    await this.authRepository.renewRefreshToken(
      row.id,
      now,
      now + this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30) * 86_400_000,
    );
    const employee = await this.authRepository.findEmployeeById(row.employeeId);
    if (!employee || !employee.isActive) {
      throw new UnauthenticatedException();
    }
    return employee;
  }

  async listDevices(employeeId: string): Promise<DeviceDto[]> {
    const rows = await this.authRepository.findRefreshTokensByEmployee(employeeId);
    return rows
      .filter((row) => row.revokedAt === null && row.expiresAt > Date.now())
      .map((row) => ({
        id: row.id,
        deviceLabel: row.deviceLabel,
        lastUsedAt: row.lastUsedAt,
        createdAt: row.createdAt,
      }));
  }

  /** Owner-triggered "revoke device" — a stolen/lost staff device dies here. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.authRepository.revokeRefreshToken(deviceId, Date.now());
  }

  static hashToken(rawToken: string): string {
    // SHA-256 for opaque tokens where reversal is never needed (Security §4).
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
