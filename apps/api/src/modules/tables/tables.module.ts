import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MenuModule } from '../menu/menu.module';
import { RestaurantConfigModule } from '../config/restaurant-config.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { TABLES_REPOSITORY, DrizzleTablesRepository } from './tables.repository';

/**
 * Floor domain (halls, tables, QR tokens, customer menu entry). Imports menu
 * for the public endpoint's live-menu read and config for its branding
 * object (Step 3.10, ruling B2(a)) — legal, acyclic module dependencies
 * through exported providers (Engineering Standards §2/§5): tables → menu,
 * tables → config, config → menu; config never imports tables.
 * TablesService is exported for the future setup-wizard module, which
 * composes hall/table creation during first-run setup (FR15/FR16).
 */
@Module({
  imports: [AuthModule, AuditModule, MenuModule, RestaurantConfigModule],
  controllers: [TablesController],
  providers: [
    TablesService,
    { provide: TABLES_REPOSITORY, useClass: DrizzleTablesRepository },
  ],
  exports: [TablesService],
})
export class TablesModule {}
