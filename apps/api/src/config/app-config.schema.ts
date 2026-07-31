import { plainToInstance } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, validateSync } from 'class-validator';

/**
 * Typed configuration schema — Engineering Standards §9.
 *
 * The application must fail fast at startup with a clear error if a required
 * value is missing or malformed, rather than failing unpredictably later.
 * These values are bootstrap-level only (DB file path, port) — everything
 * the Owner can edit through the Admin Dashboard lives in the
 * `restaurant_profile` database table instead (Database Schema Design §1),
 * never here.
 */
export class AppConfig {
  @IsString()
  DATABASE_FILE_PATH!: string;

  @IsInt()
  @Min(1)
  HTTP_PORT!: number;

  @IsInt()
  @Min(1)
  HTTPS_PORT!: number;

  @IsString()
  JWT_SIGNING_KEY!: string; // sourced from Electron safeStorage at Host bootstrap, not from a .env file — see Security Architecture §4

  @IsString()
  LOG_DIRECTORY!: string;

  @IsString()
  BACKUP_DIRECTORY!: string;

  // --- Tunable thresholds (Engineering Standards §9 — never magic numbers in
  // business logic). All optional: the defaults below are the frozen product
  // defaults, overridable per installation without a code change.

  /** FR26 — invitation expiry, default 7 days, adjustable up to 30. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  INVITATION_EXPIRY_DAYS: number = 7;

  /** API Contract Design §1 — acting-employee JWT lifetime (15 minutes). */
  @IsOptional()
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS: number = 900;

  /** Security Architecture §1 — Device Trust refresh token lifetime (30 days). */
  @IsOptional()
  @IsInt()
  @Min(1)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  /** Local directory for re-encoded uploads (product images now, restaurant
   * logo when the config module lands) — Database Schema Design stores the
   * path (`image_path`/`logo_path`), never the bytes. Relative paths resolve
   * against the Host's working directory, like DATABASE_FILE_PATH. */
  @IsOptional()
  @IsString()
  UPLOAD_DIRECTORY: string = 'uploads';

  /** Security Architecture §6 — per-file upload ceiling (default 5 MB).
   * Upload size is also an input to the Host's disk-space monitoring. */
  @IsOptional()
  @IsInt()
  @Min(1)
  UPLOAD_MAX_FILE_SIZE_BYTES: number = 5 * 1024 * 1024;
}

/**
 * Validates raw config at startup. Throws immediately (fail-fast) if invalid —
 * the Host must never boot the API against an incomplete configuration.
 */
export function validateAppConfig(raw: Record<string, unknown>): AppConfig {
  const validated = plainToInstance(AppConfig, raw, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid application configuration — refusing to start. Details: ${details}`);
  }

  return validated;
}
