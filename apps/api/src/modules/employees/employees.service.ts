import { Inject, Injectable } from '@nestjs/common';
import { InvitationStatus } from '@smarttable/shared-types';
import type {
  CreateEmployeeResponse,
  DeviceDto,
  EmployeeDto,
  EmployeePresenceResponse,
  EmployeeRole,
} from '@smarttable/shared-types';
import { EMPLOYEES_REPOSITORY, EmployeesRepository } from './employees.repository';
import { InvitationsService } from '../invitations/invitations.service';
import { AuthService } from '../auth/auth.service';
import { TokensService } from '../auth/tokens.service';
import { AuditService } from '../audit/audit.service';
import { PresenceRegistry } from '../../common/realtime/presence-registry';
import { EntityNotFoundException } from '../../common/exceptions/domain.exception';

type EmployeeRow = Awaited<ReturnType<EmployeesRepository['findById']>> & {};

/**
 * Staff account management (FR22, FR24, FR28) — the Owner's self-service
 * employee administration. Credentials are NEVER handled here beyond the
 * Owner-triggered PIN reset: passwords/PINs are set by the employee
 * themselves at invitation acceptance (FR27), never chosen by the Owner.
 */
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(EMPLOYEES_REPOSITORY) private readonly employeesRepository: EmployeesRepository,
    private readonly invitationsService: InvitationsService,
    private readonly authService: AuthService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly presence: PresenceRegistry,
  ) {}

  /** FR28 / API Contract §3 — current online/offline for one employee, read
   * from the in-memory gateway state (PresenceRegistry, ADR-011), NEVER the
   * database (Step 3.15 ruling B3(a)): an unknown employee id is simply
   * offline — the registry is the single source of truth and no existence
   * check is performed. Read-only: no audit entry (Monitoring §1), no
   * events. */
  getPresence(employeeId: string): EmployeePresenceResponse {
    return { employeeId, online: this.presence.isOnline(employeeId) };
  }

  /** FR28 roster — every employee with their latest invitation status and
   * last login timestamp. Presence is deliberately not part of this DTO
   * (Step 3.15 ruling B5(a)): it is served by GET /employees/:id/presence
   * from the in-memory registry, and clients compose the two. */
  async list(page: number, pageSize: number): Promise<{ employees: EmployeeDto[]; total: number }> {
    const { rows, total } = await this.employeesRepository.list(page, pageSize);
    const statusByEmployee = await this.invitationsService.getLatestStatusByEmployeeIds(
      rows.map((row) => row.id),
    );
    return {
      employees: rows.map((row) => this.toDto(row, statusByEmployee.get(row.id) ?? null)),
      total,
    };
  }

  /** FR24 — create the employee record and generate their invitation in one
   * action; the raw invitation token is returned exactly once, for the
   * Owner to share via Copy Link / QR Code (the primary, no-internet
   * channels; Email remains a recorded-but-optional convenience). */
  async create(
    input: { name: string; role: EmployeeRole; email?: string },
    actorEmployeeId: string,
  ): Promise<CreateEmployeeResponse> {
    const employee = await this.employeesRepository.insert({
      name: input.name,
      role: input.role,
      email: input.email ?? null,
    });
    await this.audit.append({
      actorEmployeeId,
      entityType: 'employee',
      entityId: employee.id,
      action: 'employee_created',
      newValueJson: JSON.stringify({ name: employee.name, role: employee.role }),
    });

    const invitation = await this.invitationsService.createForEmployee(employee.id, actorEmployeeId);
    return {
      employee: this.toDto(employee, InvitationStatus.PENDING),
      invitation: { id: invitation.id, token: invitation.token, expiresAt: invitation.expiresAt },
    };
  }

  /** FR22 — role reassignment (audited as `role_changed` with old/new
   * values per FR38) and deactivation (soft delete — historical records
   * keep referencing this employee forever, per the schema's soft-delete
   * rule for historically-referenced entities). */
  async update(
    id: string,
    changes: { role?: EmployeeRole; isActive?: boolean },
    actorEmployeeId: string,
  ): Promise<EmployeeDto> {
    const existing = await this.employeesRepository.findById(id);
    if (!existing) throw new EntityNotFoundException('employee', id);

    const updated = await this.employeesRepository.update(id, {
      ...(changes.role !== undefined ? { role: changes.role } : {}),
      ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
    });

    if (changes.role !== undefined && changes.role !== existing.role) {
      await this.audit.append({
        actorEmployeeId,
        entityType: 'employee',
        entityId: id,
        action: 'role_changed',
        oldValueJson: JSON.stringify({ role: existing.role }),
        newValueJson: JSON.stringify({ role: changes.role }),
      });
    }
    if (changes.isActive !== undefined && changes.isActive !== existing.isActive) {
      await this.audit.append({
        actorEmployeeId,
        entityType: 'employee',
        entityId: id,
        action: changes.isActive ? 'employee_reactivated' : 'employee_deactivated',
        oldValueJson: JSON.stringify({ isActive: existing.isActive }),
        newValueJson: JSON.stringify({ isActive: changes.isActive }),
      });
    }

    const statusByEmployee = await this.invitationsService.getLatestStatusByEmployeeIds([id]);
    return this.toDto(updated!, statusByEmployee.get(id) ?? null);
  }

  /** Owner-triggered PIN reset — audited per Security Architecture §9. */
  async resetPin(id: string, newPin: string, actorEmployeeId: string): Promise<void> {
    const existing = await this.employeesRepository.findById(id);
    if (!existing) throw new EntityNotFoundException('employee', id);
    await this.authService.setPin(id, newPin);
    await this.audit.append({
      actorEmployeeId,
      entityType: 'employee',
      entityId: id,
      action: 'pin_reset',
    });
  }

  /** Active Devices screen (Security Architecture §1). */
  async listDevices(employeeId: string): Promise<DeviceDto[]> {
    const existing = await this.employeesRepository.findById(employeeId);
    if (!existing) throw new EntityNotFoundException('employee', employeeId);
    return this.tokens.listDevices(employeeId);
  }

  /** Stolen/lost staff device → instant revocation (Security §7 checklist). */
  async revokeDevice(deviceId: string, actorEmployeeId: string): Promise<void> {
    await this.tokens.revokeDevice(deviceId);
    await this.audit.append({
      actorEmployeeId,
      entityType: 'refresh_token',
      entityId: deviceId,
      action: 'device_revoked',
    });
  }

  /** Response DTO mapping — passwordHash/pinHash are structurally excluded
   * here (API Contract §6: entities never serialize directly). */
  private toDto(row: EmployeeRow, invitationStatus: InvitationStatus | null): EmployeeDto {
    return {
      id: row!.id,
      name: row!.name,
      role: row!.role as EmployeeRole,
      email: row!.email,
      isActive: row!.isActive,
      lastLoginAt: row!.lastLoginAt,
      createdAt: row!.createdAt,
      invitationStatus,
    };
  }
}
