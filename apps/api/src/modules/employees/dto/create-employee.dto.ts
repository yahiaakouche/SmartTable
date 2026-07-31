import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { EmployeeRole } from '@smarttable/shared-types';

/** FR24 — Owner creates the employee record (name, role, optional email);
 * the invitation is generated automatically alongside it. */
export class CreateEmployeeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(EmployeeRole)
  role!: EmployeeRole;

  @IsOptional()
  @IsEmail()
  email?: string;
}
