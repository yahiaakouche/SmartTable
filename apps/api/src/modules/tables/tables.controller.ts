import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PermissionKey } from '@smarttable/shared-types';
import type { HallDto, PublicMenuDto, TableDto } from '@smarttable/shared-types';
import { TablesService } from './tables.service';
import { CreateHallDto } from './dto/create-hall.dto';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Halls & tables endpoints (API Contract Design §3) plus the unauthenticated
 * customer menu entry point. Thin translation layer only — every rule lives
 * in TablesService (Engineering Standards §3).
 *
 * Permissions: viewing the floor = Owner/Manager/Cashier/Waiter (PRD §11);
 * management incl. QR regeneration = Owner/Manager (Step 3.2 ruling R2);
 * mark-cleaned = the waiter's action (Contract §3), also Owner/Manager.
 */
@Controller()
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @RequirePermission(PermissionKey.TABLES_VIEW)
  @Get('halls')
  listHalls(): Promise<HallDto[]> {
    return this.tablesService.listHalls();
  }

  @RequirePermission(PermissionKey.TABLES_MANAGE)
  @Post('halls')
  createHall(@Body() dto: CreateHallDto): Promise<HallDto> {
    return this.tablesService.createHall(dto);
  }

  @RequirePermission(PermissionKey.TABLES_VIEW)
  @Get('tables')
  listTables(): Promise<TableDto[]> {
    return this.tablesService.listTables();
  }

  /** FR20 — creation auto-generates the QR token (service-side). */
  @RequirePermission(PermissionKey.TABLES_MANAGE)
  @Post('tables')
  createTable(@Body() dto: CreateTableDto): Promise<TableDto> {
    return this.tablesService.createTable(dto);
  }

  @RequirePermission(PermissionKey.TABLES_MANAGE)
  @Patch('tables/:id')
  updateTable(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto): Promise<TableDto> {
    return this.tablesService.updateTable(id, dto);
  }

  /** Soft delete; 409 TABLE_HAS_ACTIVE_ORDER while removal is unsafe. */
  @RequirePermission(PermissionKey.TABLES_MANAGE)
  @Delete('tables/:id')
  async removeTable(@Param('id', ParseUUIDPipe) id: string): Promise<{ success: true }> {
    await this.tablesService.removeTable(id);
    return { success: true };
  }

  /** FR21 — invalidates the previous code; audited (FR38). */
  @RequirePermission(PermissionKey.TABLES_MANAGE)
  @Post('tables/:id/regenerate-qr')
  regenerateQr(@Param('id', ParseUUIDPipe) id: string, @CurrentEmployee() actor: ActingEmployee): Promise<TableDto> {
    return this.tablesService.regenerateQr(id, actor.id);
  }

  /** The waiter's loop-closing action (Contract §3). */
  @RequirePermission(PermissionKey.TABLES_MARK_CLEANED)
  @Post('tables/:id/mark-cleaned')
  markCleaned(@Param('id', ParseUUIDPipe) id: string): Promise<TableDto> {
    return this.tablesService.markCleaned(id);
  }

  /** Customer entry point (FR2) — unauthenticated by design (Security §1:
   * this channel's protection is token unguessability + rate limiting). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } }) // Security Architecture §5 — public read class
  @Get('public/menu/:qrToken')
  getPublicMenu(@Param('qrToken') qrToken: string): Promise<PublicMenuDto> {
    return this.tablesService.getPublicMenuByQrToken(qrToken);
  }
}
