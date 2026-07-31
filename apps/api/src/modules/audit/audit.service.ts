import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_REPOSITORY, AuditEntry, AuditRepository } from './audit.repository';

/**
 * The single write path into the audit trail (FR38, Security Architecture §9).
 * Every security-relevant or administrative action in the system flows through
 * here — there is deliberately no parallel security log anywhere else.
 *
 * Query-side access (GET /audit-log, Owner/Manager review screen) arrives with
 * the audit review UI step; this module currently owns the append path only.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly auditRepository: AuditRepository) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.auditRepository.append(entry);
  }
}
