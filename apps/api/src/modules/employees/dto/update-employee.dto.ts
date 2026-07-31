import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { EmployeeRole } from '@smarttable/shared-types';

/** PATCH /employees/:id — role reassignment or deactivation (soft delete). */
export class UpdateEmployeeDto {
  @IsOptional()
  @IsEnum(EmployeeRole)
  role?: EmployeeRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
