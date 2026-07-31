import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EMPLOYEES_REPOSITORY, DrizzleEmployeesRepository } from './employees.repository';

/**
 * Staff account administration. Dependency direction is strictly one-way:
 * employees → invitations → auth (Engineering Standards §5, no cycles).
 */
@Module({
  imports: [AuthModule, InvitationsModule, AuditModule],
  controllers: [EmployeesController],
  providers: [
    EmployeesService,
    { provide: EMPLOYEES_REPOSITORY, useClass: DrizzleEmployeesRepository },
  ],
})
export class EmployeesModule {}
