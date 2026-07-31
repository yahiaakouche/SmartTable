import { ConfigService } from '@nestjs/config';
import { InvitationStatus } from '@smarttable/shared-types';
import { InvitationsService } from './invitations.service';
import { TokensService } from '../auth/tokens.service';
import {
  EntityNotFoundException,
  InvitationAlreadyAcceptedException,
  InvitationExpiredException,
} from '../../common/exceptions/domain.exception';

/**
 * Invitation lifecycle rules (FR24–FR27, NFR12): single-use, expiring,
 * revocable tokens; raw token never stored. Repositories/token issuance are
 * mocked; the lifecycle logic under test is all in the service.
 */
describe('InvitationsService', () => {
  const invitationsRepository = {
    insert: jest.fn(),
    findByTokenHash: jest.fn(),
    findById: jest.fn(),
    findPendingByEmployee: jest.fn(),
    findLatestByEmployeeIds: jest.fn(),
    markStatus: jest.fn(),
    findEmployeeIdentity: jest.fn(),
    acceptTransaction: jest.fn(),
  };
  const tokens = {
    generateDeviceTrustMaterial: jest.fn(),
    issueAccessToken: jest.fn(),
  };
  const authService = { hashCredentials: jest.fn() };
  const audit = { append: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(7) };
  const events = { emitInvitationAccepted: jest.fn() };

  let service: InvitationsService;

  const invitationRow = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'inv-1',
    employeeId: 'emp-1',
    tokenHash: 'hash',
    channel: 'link',
    status: InvitationStatus.PENDING,
    expiresAt: Date.now() + 86_400_000,
    acceptedAt: null,
    createdAt: Date.now(),
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InvitationsService(
      invitationsRepository as never,
      tokens as never,
      authService as never,
      audit as never,
      config as unknown as ConfigService,
      events as never,
    );
    invitationsRepository.findEmployeeIdentity.mockResolvedValue({ id: 'emp-1', name: 'Sofia', role: 'waiter' });
  });

  describe('createForEmployee', () => {
    it('revokes any still-pending invitation before issuing a new one (one live invitation per employee)', async () => {
      invitationsRepository.findPendingByEmployee.mockResolvedValue([invitationRow({ id: 'old-1' })]);
      invitationsRepository.insert.mockResolvedValue(invitationRow({ id: 'new-1' }));

      const issued = await service.createForEmployee('emp-1', 'owner-1');

      expect(invitationsRepository.markStatus).toHaveBeenCalledWith('old-1', InvitationStatus.REVOKED);
      expect(issued.token).toBeTruthy();
      // Only the hash is persisted — the raw token never touches the database.
      const inserted = invitationsRepository.insert.mock.calls[0][0];
      expect(inserted.tokenHash).not.toBe(issued.token);
      expect(inserted.tokenHash).toBe(TokensService.hashToken(issued.token));
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'invitation_created' }));
    });
  });

  describe('getAcceptContext / validation', () => {
    it('returns context for a valid pending token', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(invitationRow());
      const ctx = await service.getAcceptContext('raw-token');
      expect(ctx).toEqual({ employeeName: 'Sofia', role: 'waiter', expiresAt: expect.any(Number) });
    });

    it('does not resolve unknown or revoked tokens (no oracle)', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(undefined);
      await expect(service.getAcceptContext('nope')).rejects.toBeInstanceOf(EntityNotFoundException);

      invitationsRepository.findByTokenHash.mockResolvedValue(invitationRow({ status: InvitationStatus.REVOKED }));
      await expect(service.getAcceptContext('nope')).rejects.toBeInstanceOf(EntityNotFoundException);
    });

    it('rejects an already-accepted token (single-use, FR26)', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(
        invitationRow({ status: InvitationStatus.ACCEPTED }),
      );
      await expect(service.getAcceptContext('raw')).rejects.toBeInstanceOf(InvitationAlreadyAcceptedException);
    });

    it('marks a past-expiry token expired and rejects it (NFR12)', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(
        invitationRow({ expiresAt: Date.now() - 1000 }),
      );
      await expect(service.getAcceptContext('raw')).rejects.toBeInstanceOf(InvitationExpiredException);
      expect(invitationsRepository.markStatus).toHaveBeenCalledWith('inv-1', InvitationStatus.EXPIRED);
    });
  });

  describe('accept', () => {
    it('writes credentials, marks accepted, and creates Device Trust in one transaction', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(invitationRow());
      authService.hashCredentials.mockResolvedValue({ passwordHash: 'ph', pinHash: 'pih' });
      tokens.generateDeviceTrustMaterial.mockReturnValue({ rawToken: 'raw-refresh', row: { tokenHash: 'x' } });
      tokens.issueAccessToken.mockReturnValue({ accessToken: 'jwt', expiresInSeconds: 900, employee: {} });

      const result = await service.accept('raw', 'password-123', '1234', 'Cashier Station');

      expect(invitationsRepository.acceptTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          invitationId: 'inv-1',
          employeeId: 'emp-1',
          passwordHash: 'ph',
          pinHash: 'pih',
        }),
      );
      expect(result.deviceRefreshToken).toBe('raw-refresh');
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'invitation_accepted' }));
      // Contract §4 / ruling D6 — the real-time event fires post-commit so
      // owner-room dashboards see the acceptance live (FR33).
      expect(events.emitInvitationAccepted).toHaveBeenCalledWith({ invitationId: 'inv-1', employeeId: 'emp-1' });
    });

    it('does NOT emit invitation.accepted when acceptance fails pre-commit', async () => {
      invitationsRepository.findByTokenHash.mockResolvedValue(invitationRow({ status: InvitationStatus.ACCEPTED }));
      await expect(service.accept('raw', 'password-123', '1234', 'Cashier Station')).rejects.toBeInstanceOf(
        InvitationAlreadyAcceptedException,
      );
      expect(events.emitInvitationAccepted).not.toHaveBeenCalled();
    });
  });

  describe('revoke / reissue', () => {
    it('revokes a pending invitation and audit-logs it', async () => {
      invitationsRepository.findById.mockResolvedValue(invitationRow());
      await service.revoke('inv-1', 'owner-1');
      expect(invitationsRepository.markStatus).toHaveBeenCalledWith('inv-1', InvitationStatus.REVOKED);
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'invitation_revoked' }));
    });

    it('refuses to revoke a non-pending invitation', async () => {
      invitationsRepository.findById.mockResolvedValue(invitationRow({ status: InvitationStatus.ACCEPTED }));
      await expect(service.revoke('inv-1', 'owner-1')).rejects.toBeInstanceOf(InvitationAlreadyAcceptedException);
    });

    it('reissues: revokes the old token and mints a fresh one', async () => {
      invitationsRepository.findById.mockResolvedValue(invitationRow());
      invitationsRepository.findPendingByEmployee.mockResolvedValue([]);
      invitationsRepository.insert.mockResolvedValue(invitationRow({ id: 'inv-2' }));

      const issued = await service.reissue('inv-1', 'owner-1');

      expect(invitationsRepository.markStatus).toHaveBeenCalledWith('inv-1', InvitationStatus.REVOKED);
      expect(issued.id).toBe('inv-2');
      expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'invitation_reissued' }));
    });
  });

  describe('getLatestStatusByEmployeeIds (FR28 roster)', () => {
    it('reports the latest invitation per employee and maps time-expired pendings to expired', async () => {
      invitationsRepository.findLatestByEmployeeIds.mockResolvedValue([
        invitationRow({ employeeId: 'e1', status: InvitationStatus.PENDING, expiresAt: Date.now() + 1000, createdAt: 3 }),
        invitationRow({ employeeId: 'e1', status: InvitationStatus.REVOKED, createdAt: 2 }),
        invitationRow({ employeeId: 'e2', status: InvitationStatus.PENDING, expiresAt: Date.now() - 1000, createdAt: 1 }),
      ]);
      const map = await service.getLatestStatusByEmployeeIds(['e1', 'e2', 'e3']);
      expect(map.get('e1')).toBe(InvitationStatus.PENDING);
      expect(map.get('e2')).toBe(InvitationStatus.EXPIRED);
      expect(map.get('e3')).toBeUndefined();
    });
  });
});
