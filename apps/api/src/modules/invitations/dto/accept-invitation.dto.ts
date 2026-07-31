import { IsString, Matches, MinLength } from 'class-validator';

/** FR27 — acceptance sets BOTH credentials: password (account security) and
 * PIN (fast daily terminal login, 4–6 digits per Security Architecture §1). */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(8)
  password!: string;

  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  pin!: string;

  /** Human-readable label for the Active Devices screen, e.g. "Cashier Station". */
  @IsString()
  @MinLength(1)
  deviceLabel!: string;
}
