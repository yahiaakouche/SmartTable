import { Body, Controller, Get, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { CompleteSetupResponse, SetupStatusResponse } from '@smarttable/shared-types';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteSetupDto } from './dto/complete-setup.dto';
import { SetupWizardService } from './setup-wizard.service';

/**
 * Setup Wizard endpoints (API Contract §3 — `setup-wizard`). Thin
 * translation layer only — all rules live in SetupWizardService and the
 * repository's atomic transaction (Engineering Standards §3).
 *
 * Both routes are PUBLIC (ruling B1(a)): before setup completes no
 * employee exists, so no token can ever be presented — the same reason
 * the invitation-accept routes are public. Protection instead of auth:
 * the in-transaction one-shot guard (409 SETUP_ALREADY_COMPLETED) and the
 * strict throttle class on the write route.
 */
@Controller('setup')
export class SetupWizardController {
  constructor(private readonly setupWizardService: SetupWizardService) {}

  /** GET /setup/status — "Has setup been completed?" (drives the Host's
   * first-launch branch). Public read class per Security §5 (D2). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('status')
  getStatus(): Promise<SetupStatusResponse> {
    return this.setupWizardService.getStatus();
  }

  /** POST /setup/complete — submits all wizard steps atomically (profile,
   * first table batch, first Owner account). Multipart: optional `logo`
   * file part in the same call (Security §6). Bootstrap/auth throttle
   * class — same as pin-login and invitation acceptance (D2). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('complete')
  @UseInterceptors(FileInterceptor('logo'))
  complete(
    @Body() dto: CompleteSetupDto,
    @UploadedFile() logo?: Express.Multer.File,
  ): Promise<CompleteSetupResponse> {
    return this.setupWizardService.completeSetup(dto, logo?.buffer);
  }
}
