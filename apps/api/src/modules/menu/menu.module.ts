import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { MenuController } from './menu.controller';
import { UploadsController } from './uploads.controller';
import { MenuService } from './menu.service';
import { ImageStorageService } from './image-storage.service';
import { MENU_REPOSITORY, DrizzleMenuRepository } from './menu.repository';

/**
 * Menu domain (categories + products). MenuService is exported because the
 * tables module's public customer endpoint (`GET /public/menu/:qrToken`)
 * resolves the live menu through it — legal module consumption via exported
 * providers only (Engineering Standards §2), and acyclic: menu never imports
 * tables (ES §5). ImageStorageService is exported for the config module's
 * logo upload (Step 3.10 D5) — the same Security §6 pipeline, reused
 * verbatim instead of duplicated.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [MenuController, UploadsController],
  providers: [
    MenuService,
    ImageStorageService,
    { provide: MENU_REPOSITORY, useClass: DrizzleMenuRepository },
  ],
  exports: [MenuService, ImageStorageService],
})
export class MenuModule {}
