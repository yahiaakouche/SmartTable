import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { INVITATIONS_REPOSITORY, DrizzleInvitationsRepository } from './invitations.repository';

/**
 * Invitation lifecycle: issue → (validate) → accept → revoke/reissue.
 * Imports AuthModule for credential hashing and Device Trust creation —
 * the dependency direction is one-way (invitations → auth), no cycles
 * (Engineering Standards §5).
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, { provide: INVITATIONS_REPOSITORY, useClass: DrizzleInvitationsRepository }],
  exports: [InvitationsService],
})
export class InvitationsModule {}
