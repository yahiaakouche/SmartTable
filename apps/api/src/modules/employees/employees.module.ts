import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { RealtimeModule } from '../../common/realtime/realtime.module';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EMPLOYEES_REPOSITORY, DrizzleEmployeesRepository } from './employees.repository';

/**
 * Staff account administration. Dependency direction is strictly one-way:
 * employees → invitations → auth (Engineering Standards §5, no cycles).
 * Step 3.15 adds RealtimeModule for the exported PresenceRegistry — the
 * single source of truth behind GET /employees/:id/presence (read-only
 * consumer; no events, no gateway changes). RealtimeModule depends on
 * auth/health only, so the one-way rule still holds.
 */
@Module({
  imports: [AuthModule, InvitationsModule, AuditModule, RealtimeModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    { provide: EMPLOYEES_REPOSITORY, useClass: DrizzleEmployeesRepository },
  ],
})
export class EmployeesModule {}
