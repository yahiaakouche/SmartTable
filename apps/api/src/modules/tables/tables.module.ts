import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MenuModule } from '../menu/menu.module';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { TABLES_REPOSITORY, DrizzleTablesRepository } from './tables.repository';

/**
 * Floor domain (halls, tables, QR tokens, customer menu entry). Imports menu
 * for the public endpoint's live-menu read — a legal, acyclic module
 * dependency through an exported provider (Engineering Standards §2/§5).
 * TablesService is exported for the future setup-wizard module, which
 * composes hall/table creation during first-run setup (FR15/FR16).
 */
@Module({
  imports: [AuthModule, AuditModule, MenuModule],
  controllers: [TablesController],
  providers: [
    TablesService,
    { provide: TABLES_REPOSITORY, useClass: DrizzleTablesRepository },
  ],
  exports: [TablesService],
})
export class TablesModule {}
