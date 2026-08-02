import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MenuModule } from '../menu/menu.module';
import { RestaurantConfigModule } from '../config/restaurant-config.module';
import { SetupWizardController } from './setup-wizard.controller';
import { SetupWizardService } from './setup-wizard.service';
import { SETUP_WIZARD_REPOSITORY, DrizzleSetupWizardRepository } from './setup-wizard.repository';

/**
 * First-run Setup Wizard (API Contract §3 `setup-wizard`, FR15/FR16) —
 * the one-time public bootstrap. Dependency direction stays acyclic:
 * setup-wizard → config → menu, setup-wizard → menu (logo pipeline),
 * setup-wizard → auth (credential hashing), setup-wizard → audit; the
 * module is terminal — nothing imports it (Engineering Standards §5).
 *
 * Reused, never duplicated: AuthService.hashCredentials (FR27's Argon2id
 * path), ImageStorageService (Security §6), RestaurantConfigService's
 * tolerant profile read (status), AuditService (bootstrap audit row).
 */
@Module({
  imports: [AuthModule, RestaurantConfigModule, MenuModule, AuditModule],
  controllers: [SetupWizardController],
  providers: [
    SetupWizardService,
    { provide: SETUP_WIZARD_REPOSITORY, useClass: DrizzleSetupWizardRepository },
  ],
})
export class SetupWizardModule {}
