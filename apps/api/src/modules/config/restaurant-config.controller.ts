import { Body, Controller, Get, Patch, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PermissionKey } from '@smarttable/shared-types';
import type { RestaurantProfileDto } from '@smarttable/shared-types';
import { ActingEmployee, CurrentEmployee } from '../auth/decorators/current-employee.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { UpdateRestaurantProfileDto } from './dto/update-restaurant-profile.dto';
import { RestaurantConfigService } from './restaurant-config.service';

/**
 * Config endpoints (API Contract §3 — `config`, branding/settings). Thin
 * translation layer only — all rules live in RestaurantConfigService
 * (Engineering Standards §3).
 *
 * The module class is named RestaurantConfigModule precisely so it can
 * never be confused with the env/bootstrap ConfigModule in src/config —
 * while the ROUTE prefix stays the contract's frozen `config`.
 */
@Controller('config')
export class RestaurantConfigController {
  constructor(private readonly configService: RestaurantConfigService) {}

  /** GET /config/restaurant-profile — all five staff roles (D6). 404 until
   * the Setup Wizard creates the row (ruling B3(a)). */
  @RequirePermission(PermissionKey.CONFIG_VIEW)
  @Get('restaurant-profile')
  getProfile(): Promise<RestaurantProfileDto> {
    return this.configService.getProfile();
  }

  /** PATCH /config/restaurant-profile — Owner only (ruling B1(a)).
   * Multipart: optional `logo` file part in the same call (Security §6). */
  @RequirePermission(PermissionKey.CONFIG_MANAGE)
  @Patch('restaurant-profile')
  @UseInterceptors(FileInterceptor('logo'))
  updateProfile(
    @Body() dto: UpdateRestaurantProfileDto,
    @CurrentEmployee() actor: ActingEmployee,
    @UploadedFile() logo?: Express.Multer.File,
  ): Promise<RestaurantProfileDto> {
    return this.configService.updateProfile(actor.id, dto, logo?.buffer);
  }
}
