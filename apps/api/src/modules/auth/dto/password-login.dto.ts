import { IsString, MinLength } from 'class-validator';

export class PasswordLoginDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  /** Human-readable label for the Active Devices screen, e.g. "Owner Laptop". */
  @IsString()
  @MinLength(1)
  deviceLabel!: string;
}
