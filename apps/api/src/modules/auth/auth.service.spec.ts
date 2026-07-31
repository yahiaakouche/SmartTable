import * as argon2 from 'argon2';
import { EmployeeRole } from '@smarttable/shared-types';
import { AuthService } from './auth.service';
import {
  AccountLockedException,
  UnauthenticatedException,
} from '../../common/exceptions/domain.exception';

/**
 * Authentication business rules (Engineering Standards §10 — RBAC-adjacent,
 * security-critical). Repositories and token issuance are mocked; Argon2 is
 * real, so verification behavior is tested end-to-end at the unit level.
 */
describe('AuthService', () => {
  const authRepository = {
    findEmployeeById: jest.fn(),
    findActiveEmployeesByName: jest.fn(),
    recordLogin: jest.fn(),
  };
  const tokens = {
    validateAndRenewDeviceTrust: jest.fn(),
    issueAccessToken: jest.fn(),
    createDeviceTrust: jest.fn(),
  };
  const pinLockout = {
    getLockRemainingMs: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  };
  const audit = { append: jest.fn() };

  let service: AuthService;

  const employee = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'emp-1',
    name: 'Sofia',
    role: EmployeeRole.WAITER,
    isActive: true,
    email: null,
    passwordHash: null,
    pinHash: null,
    lastLoginAt: null,
    createdAt: 1,
    ...over,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new AuthService(
      authRepository as never,
      tokens as never,
      pinLockout as never,
      audit as never,
    );
    pinLockout.getLockRemainingMs.mockReturnValue(0);
    tokens.issueAccessToken.mockReturnValue({ accessToken: 'jwt', expiresInSeconds: 900, employee: {} });
  });

  describe('pinLogin', () => {
    it('rejects a locked account before any credential work', async () => {
      pinLockout.getLockRemainingMs.mockReturnValue(42_000);
      await expect(service.pinLogin('rt', 'emp-1', '1234')).rejects.toBeInstanceOf(AccountLockedException);
      expect(authRepository.findEmployeeById).not.toHaveBeenCalled();
    });

    it('rejects when the device trust belongs to a different employee', async () => {
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee({ id: 'someone-else' }));
      await expect(service.pinLogin('rt', 'emp-1', '1234')).rejects.toBeInstanceOf(UnauthenticatedException);
    });

    it('rejects a wrong PIN, records the failure, and audit-logs it', async () => {
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee());
      authRepository.findEmployeeById.mockResolvedValue(
        employee({ pinHash: await argon2.hash('9999') }),
      );
      pinLockout.recordFailure.mockReturnValue(null);

      await expect(service.pinLogin('rt', 'emp-1', '1234')).rejects.toBeInstanceOf(UnauthenticatedException);
      expect(pinLockout.recordFailure).toHaveBeenCalledWith('emp-1');
      expect(audit.append).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'login_failed', entityId: 'emp-1' }),
      );
    });

    it('throws AccountLocked and audit-logs account_locked when the failure triggers a lock', async () => {
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee());
      authRepository.findEmployeeById.mockResolvedValue(
        employee({ pinHash: await argon2.hash('9999') }),
      );
      pinLockout.recordFailure.mockReturnValue(60_000);

      await expect(service.pinLogin('rt', 'emp-1', '1234')).rejects.toBeInstanceOf(AccountLockedException);
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'account_locked' }));
    });

    it('succeeds with the correct PIN, resets lockout, and records the login', async () => {
      const pinHash = await argon2.hash('1234');
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee());
      authRepository.findEmployeeById.mockResolvedValue(employee({ pinHash }));

      const result = await service.pinLogin('rt', 'emp-1', '1234');

      expect(result.accessToken).toBe('jwt');
      expect(pinLockout.recordSuccess).toHaveBeenCalledWith('emp-1');
      expect(authRepository.recordLogin).toHaveBeenCalledWith('emp-1', expect.any(Number));
    });

    it('rejects PIN login for a deactivated employee', async () => {
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee());
      authRepository.findEmployeeById.mockResolvedValue(
        employee({ isActive: false, pinHash: await argon2.hash('1234') }),
      );
      pinLockout.recordFailure.mockReturnValue(null);
      await expect(service.pinLogin('rt', 'emp-1', '1234')).rejects.toBeInstanceOf(UnauthenticatedException);
    });
  });

  describe('passwordLogin', () => {
    it('authenticates an Owner and establishes Device Trust for the new device', async () => {
      authRepository.findActiveEmployeesByName.mockResolvedValue([
        employee({ id: 'owner-1', role: EmployeeRole.OWNER, passwordHash: await argon2.hash('correct-horse') }),
      ]);
      tokens.createDeviceTrust.mockResolvedValue({ rawToken: 'raw-refresh' });

      const result = await service.passwordLogin('Karim', 'correct-horse', 'Owner Laptop');

      expect(result.deviceRefreshToken).toBe('raw-refresh');
      expect(tokens.createDeviceTrust).toHaveBeenCalledWith('owner-1', 'Owner Laptop');
      expect(authRepository.recordLogin).toHaveBeenCalledWith('owner-1', expect.any(Number));
    });

    it('rejects non-Owner/Manager roles even with the correct password (Security §1)', async () => {
      authRepository.findActiveEmployeesByName.mockResolvedValue([
        employee({ role: EmployeeRole.WAITER, passwordHash: await argon2.hash('correct-horse') }),
      ]);
      await expect(service.passwordLogin('Sofia', 'correct-horse', 'Tablet')).rejects.toBeInstanceOf(
        UnauthenticatedException,
      );
    });

    it('rejects a wrong password and audit-logs the failure', async () => {
      authRepository.findActiveEmployeesByName.mockResolvedValue([
        employee({ role: EmployeeRole.MANAGER, passwordHash: await argon2.hash('right') }),
      ]);
      await expect(service.passwordLogin('Amina', 'wrong', 'Laptop')).rejects.toBeInstanceOf(
        UnauthenticatedException,
      );
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'login_failed' }));
    });
  });

  describe('refresh / setPin', () => {
    it('issues a new access token from a valid device trust token', async () => {
      tokens.validateAndRenewDeviceTrust.mockResolvedValue(employee());
      const result = await service.refresh('raw-refresh');
      expect(result.accessToken).toBe('jwt');
    });

    it('stores PINs only as Argon2 hashes, never raw', async () => {
      const setPinHash = jest.fn();
      const repo = { ...authRepository, setPinHash } as never;
      const svc = new AuthService(repo, tokens as never, pinLockout as never, audit as never);
      await svc.setPin('emp-1', '4321');
      const storedHash = setPinHash.mock.calls[0][1] as string;
      expect(storedHash).not.toContain('4321');
      await expect(argon2.verify(storedHash, '4321')).resolves.toBe(true);
    });
  });
});
