import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MenuModule } from '../menu/menu.module';
import { RestaurantConfigController } from './restaurant-config.controller';
import { RestaurantConfigService } from './restaurant-config.service';
import { CONFIG_REPOSITORY, DrizzleConfigRepository } from './restaurant-config.repository';

/**
 * Config domain (branding/settings) — Step 3.10. Imports menu for the
 * Security §6 image pipeline (ImageStorageService — the logo upload reuses
 * it verbatim, D5) — a legal, acyclic module dependency through an exported
 * provider: config → menu, and menu never imports config (ES §2/§5).
 *
 * RestaurantConfigService is exported because the tables module's public
 * customer menu carries the branding object (ruling B2(a)) — consumed
 * through the exported provider only.
 */
@Module({
  imports: [AuthModule, AuditModule, MenuModule],
  controllers: [RestaurantConfigController],
  providers: [
    RestaurantConfigService,
    { provide: CONFIG_REPOSITORY, useClass: DrizzleConfigRepository },
  ],
  exports: [RestaurantConfigService],
})
export class RestaurantConfigModule {}
