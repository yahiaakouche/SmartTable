import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PermissionKey } from '@smarttable/shared-types';
import type { AcceptInvitationResponse, InvitationContextDto } from '@smarttable/shared-types';
import { InvitationsService, IssuedInvitation } from './invitations.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Employee Invitation & Onboarding endpoints (API Contract Design §3).
 * The accept endpoints are the unauthenticated entry point for a new
 * employee — rate-limited per Security Architecture §5 (tokens are
 * unguessable by design; throttling is cheap defense-in-depth).
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('accept/:token')
  getAcceptContext(@Param('token') token: string): Promise<InvitationContextDto> {
    return this.invitationsService.getAcceptContext(token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept/:token')
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<AcceptInvitationResponse> {
    return this.invitationsService.accept(token, dto.password, dto.pin, dto.deviceLabel);
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Post(':id/revoke')
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<{ success: true }> {
    await this.invitationsService.revoke(id, actor.id);
    return { success: true };
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Post(':id/reissue')
  reissue(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<IssuedInvitation> {
    return this.invitationsService.reissue(id, actor.id);
  }
}
