import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { InvitationStatus } from '@smarttable/shared-types';
import type {
  AcceptInvitationResponse,
  EmployeeRole,
  InvitationContextDto,
} from '@smarttable/shared-types';
import { INVITATIONS_REPOSITORY, InvitationsRepository } from './invitations.repository';
import { TokensService } from '../auth/tokens.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import {
  EntityNotFoundException,
  InvitationAlreadyAcceptedException,
  InvitationExpiredException,
} from '../../common/exceptions/domain.exception';

type InvitationRow = Awaited<ReturnType<InvitationsRepository['findById']>> & {};

export interface IssuedInvitation {
  id: string;
  token: string;
  expiresAt: number;
}

/**
 * Employee Invitation & Onboarding (PRD §7 item 18, FR24–FR27, NFR12).
 * Tokens are cryptographically random (32 bytes), single-use, expiring
 * (default 7 days, configurable up to 30 — FR26), and revocable; only the
 * SHA-256 hash is ever stored — the raw token is shown to the Owner exactly
 * once, the same discipline as passwords (Database Schema Design §2).
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(INVITATIONS_REPOSITORY) private readonly invitationsRepository: InvitationsRepository,
    private readonly tokens: TokensService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issues a fresh invitation for an employee. Any still-pending invitation
   * for the same employee is revoked first — there is never more than one
   * live invitation per employee, which keeps "reissue" semantics identical
   * to "create" (FR26: revocable and re-issuable at any time).
   */
  async createForEmployee(employeeId: string, actorEmployeeId: string | null, channel = 'link'): Promise<IssuedInvitation> {
    const pending = await this.invitationsRepository.findPendingByEmployee(employeeId);
    for (const old of pending) {
      await this.invitationsRepository.markStatus(old.id, InvitationStatus.REVOKED);
    }

    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.config.get<number>('INVITATION_EXPIRY_DAYS', 7) * 86_400_000;
    const row = await this.invitationsRepository.insert({
      employeeId,
      tokenHash: TokensService.hashToken(rawToken),
      channel,
      expiresAt,
    });

    await this.audit.append({
      actorEmployeeId,
      entityType: 'invitation',
      entityId: row.id,
      action: 'invitation_created',
      newValueJson: JSON.stringify({ employeeId, channel, expiresAt }),
    });

    return { id: row.id, token: rawToken, expiresAt: row.expiresAt };
  }

  /** GET /invitations/accept/:token — validates and returns pre-acceptance context. */
  async getAcceptContext(rawToken: string): Promise<InvitationContextDto> {
    const invitation = await this.validateTokenForUse(rawToken);
    const employee = await this.invitationsRepository.findEmployeeIdentity(invitation!.employeeId);
    if (!employee) throw new EntityNotFoundException('employee', invitation!.employeeId);
    return {
      employeeName: employee.name,
      role: employee.role as EmployeeRole,
      expiresAt: invitation!.expiresAt,
    };
  }

  /**
   * POST /invitations/accept/:token — FR27: the employee sets their password
   * (account security) and PIN (fast daily terminal login); Device Trust is
   * established for the accepting device in the same transaction, so the
   * employee lands directly on their role's dashboard, logged in.
   */
  async accept(
    rawToken: string,
    password: string,
    pin: string,
    deviceLabel: string,
  ): Promise<AcceptInvitationResponse> {
    const invitation = await this.validateTokenForUse(rawToken);
    const employee = await this.invitationsRepository.findEmployeeIdentity(invitation!.employeeId);
    if (!employee) throw new EntityNotFoundException('employee', invitation!.employeeId);

    const { passwordHash, pinHash } = await this.authService.hashCredentials(password, pin);
    const deviceTrust = this.tokens.generateDeviceTrustMaterial(employee.id, deviceLabel);

    await this.invitationsRepository.acceptTransaction({
      invitationId: invitation!.id,
      employeeId: employee.id,
      passwordHash,
      pinHash,
      acceptedAt: Date.now(),
      refreshTokenRow: deviceTrust.row,
    });

    await this.audit.append({
      actorEmployeeId: employee.id,
      entityType: 'invitation',
      entityId: invitation!.id,
      action: 'invitation_accepted',
      newValueJson: JSON.stringify({ employeeId: employee.id, deviceLabel }),
    });

    return {
      ...this.tokens.issueAccessToken(employee),
      deviceRefreshToken: deviceTrust.rawToken,
    };
  }

  /** FR26 — Owner revokes a live invitation at any time. */
  async revoke(invitationId: string, actorEmployeeId: string): Promise<void> {
    const invitation = await this.invitationsRepository.findById(invitationId);
    if (!invitation) throw new EntityNotFoundException('invitation', invitationId);
    if (invitation.status !== InvitationStatus.PENDING) {
      throw new InvitationAlreadyAcceptedException(invitationId);
    }
    await this.invitationsRepository.markStatus(invitationId, InvitationStatus.REVOKED);
    await this.audit.append({
      actorEmployeeId,
      entityType: 'invitation',
      entityId: invitationId,
      action: 'invitation_revoked',
      oldValueJson: JSON.stringify({ status: invitation.status }),
      newValueJson: JSON.stringify({ status: InvitationStatus.REVOKED }),
    });
  }

  /** FR26 — re-issue: revoke the old invitation, mint a fresh token. */
  async reissue(invitationId: string, actorEmployeeId: string): Promise<IssuedInvitation> {
    const invitation = await this.invitationsRepository.findById(invitationId);
    if (!invitation) throw new EntityNotFoundException('invitation', invitationId);
    if (invitation.status === InvitationStatus.PENDING) {
      await this.invitationsRepository.markStatus(invitationId, InvitationStatus.REVOKED);
    }
    const issued = await this.createForEmployee(invitation.employeeId, actorEmployeeId, invitation.channel);
    await this.audit.append({
      actorEmployeeId,
      entityType: 'invitation',
      entityId: invitationId,
      action: 'invitation_reissued',
      newValueJson: JSON.stringify({ newInvitationId: issued.id }),
    });
    return issued;
  }

  /** FR28 — latest invitation status per employee, for the Owner's roster. */
  async getLatestStatusByEmployeeIds(employeeIds: string[]): Promise<Map<string, InvitationStatus>> {
    const rows = await this.invitationsRepository.findLatestByEmployeeIds(employeeIds);
    const latest = new Map<string, InvitationStatus>();
    for (const row of rows) {
      // Rows arrive newest-first; the first row seen per employee wins.
      if (!latest.has(row.employeeId)) {
        const isExpired = row.status === InvitationStatus.PENDING && row.expiresAt <= Date.now();
        latest.set(row.employeeId, isExpired ? InvitationStatus.EXPIRED : (row.status as InvitationStatus));
      }
    }
    return latest;
  }

  /** Shared validation for both accept endpoints — the single-use (FR26),
   * expiry (NFR12), and revocation rules live in exactly one place. */
  private async validateTokenForUse(rawToken: string): Promise<InvitationRow> {
    const invitation = await this.invitationsRepository.findByTokenHash(TokensService.hashToken(rawToken));

    // Unknown or revoked tokens simply do not resolve (404) — the endpoint
    // must never become an oracle for which tokens exist or why they failed.
    if (!invitation || invitation.status === InvitationStatus.REVOKED) {
      throw new EntityNotFoundException('invitation', '(token)');
    }
    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new InvitationAlreadyAcceptedException(invitation.id);
    }
    if (invitation.expiresAt <= Date.now()) {
      await this.invitationsRepository.markStatus(invitation.id, InvitationStatus.EXPIRED);
      throw new InvitationExpiredException(invitation.id);
    }
    return invitation;
  }
}
