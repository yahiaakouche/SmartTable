import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** POST /backup/create — the optional export passphrase (Security §4 freezes
 * the capability at this route: "accepts an optional passphrase"). Bounds are
 * the implementation-level default (D14): long enough to matter, capped so a
 * malformed client cannot force multi-minute scrypt derivations. */
export class CreateBackupDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  passphrase?: string;
}
