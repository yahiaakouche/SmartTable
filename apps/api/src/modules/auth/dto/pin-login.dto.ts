import { IsString, IsUUID, Matches } from 'class-validator';

/** PIN is 4–6 digits (Security Architecture §1, Owner-configurable policy;
 * the DTO enforces the structural shape, the account lockout enforces the rest). */
export class PinLoginDto {
  @IsString()
  deviceRefreshToken!: string;

  @IsUUID()
  employeeId!: string;

  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  pin!: string;
}
