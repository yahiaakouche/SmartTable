import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * PATCH /config/restaurant-profile — accepted as multipart so the logo can
 * be replaced in the same call (Security §6 names this exact route as the
 * logo-upload endpoint). Every field is optional; the service rejects a
 * call that changes nothing (D3). `setupCompletedAt`, `id` and `updatedAt`
 * are deliberately absent — the global pipe's `forbidNonWhitelisted` makes
 * sending them a 400 (D10).
 */
export class UpdateRestaurantProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'primaryColor must be a #RRGGBB hex color' })
  primaryColor?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'secondaryColor must be a #RRGGBB hex color' })
  secondaryColor?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be an ISO-4217 alpha-3 code' })
  currencyCode?: string;

  /** Integer basis points (1900 = 19.00%); 10000 is the 100.00% ceiling
   * (D2 — the DB CHECK only enforces >= 0, the sane bound lives here). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  taxRatePercent?: number;

  /** Mirrors the DB CHECK constraint exactly. */
  @IsOptional()
  @IsIn(['ar', 'fr'])
  defaultLanguage?: 'ar' | 'fr';
}
