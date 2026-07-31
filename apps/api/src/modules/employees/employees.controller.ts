import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { PermissionKey } from '@smarttable/shared-types';
import type {
  CreateEmployeeResponse,
  DeviceDto,
  EmployeeDto,
} from '@smarttable/shared-types';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Staff management endpoints (API Contract Design §3). Thin translation
 * layer only — all rules live in EmployeesService (Engineering Standards §3).
 * Permissions follow PRD §11: roster viewing is Owner+Manager; every
 * mutation is Owner-only (`staff.manage`).
 */
@Controller()
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @RequirePermission(PermissionKey.STAFF_VIEW_ROSTER)
  @Get('employees')
  async list(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize = 50,
  ) {
    const result = await this.employeesService.list(page, pageSize);
    // Offset pagination envelope for bounded resources (API Contract §1).
    return { data: result.employees, meta: { page, pageSize, total: result.total } };
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Post('employees')
  create(
    @Body() dto: CreateEmployeeDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<CreateEmployeeResponse> {
    return this.employeesService.create(dto, actor.id);
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Patch('employees/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<EmployeeDto> {
    return this.employeesService.update(id, dto, actor.id);
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Post('employees/:id/reset-pin')
  async resetPin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPinDto,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<{ success: true }> {
    await this.employeesService.resetPin(id, dto.newPin, actor.id);
    return { success: true };
  }

  /** Active Devices screen (Security Architecture §1). */
  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Get('employees/:id/devices')
  listDevices(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceDto[]> {
    return this.employeesService.listDevices(id);
  }

  @RequirePermission(PermissionKey.STAFF_MANAGE)
  @Post('devices/:id/revoke')
  async revokeDevice(
    @Param('id', ParseUUIDPipe) deviceId: string,
    @CurrentEmployee() actor: ActingEmployee,
  ): Promise<{ success: true }> {
    await this.employeesService.revokeDevice(deviceId, actor.id);
    return { success: true };
  }
}
