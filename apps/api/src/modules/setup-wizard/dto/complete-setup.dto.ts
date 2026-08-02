import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * POST /setup/complete — accepted as multipart so the logo uploads in the
 * same atomic call (Security §6 pipeline), which is why every field is a
 * flat scalar: multipart form fields cannot carry a nested owner object,
 * so the credentials arrive as the three `owner*` fields (see
 * CompleteSetupRequest in shared-types).
 *
 * Shape is exactly FR15's list — name, colors, currency (default DZD),
 * language (default Arabic), number of tables, first Owner credentials
 * (B4(a): BOTH password and PIN, mirroring AcceptInvitationDto). No
 * `taxRatePercent`, no `email`, no `setupCompletedAt` — the global pipe's
 * `forbidNonWhitelisted` makes sending them a 400.
 */
export class CompleteSetupDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'primaryColor must be a #RRGGBB hex color' })
  primaryColor!: string;

  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'secondaryColor must be a #RRGGBB hex color' })
  secondaryColor!: string;

  /** Optional — FR15 default DZD is applied by the service. */
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be an ISO-4217 alpha-3 code' })
  currencyCode?: string;

  /** Optional — FR15 default Arabic is applied by the service. Mirrors
   * the DB CHECK constraint exactly. */
  @IsOptional()
  @IsIn(['ar', 'fr'])
  defaultLanguage?: 'ar' | 'fr';

  /** B2(a) — count only. Min 1: FR15 requires tables (a table-less
   * restaurant is degenerate). Max 200: a generous ceiling over the PRD's
   * "20+ tables" scale, guarding the public endpoint against
   * payload-driven resource abuse (R6) — validation rejects before any
   * write happens. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  tableCount!: number;

  @IsString()
  @Length(1, 100)
  ownerName!: string;

  /** Same policy as invitation acceptance (FR27). */
  @IsString()
  @MinLength(8)
  ownerPassword!: string;

  /** Security Architecture §1 — 4–6 digits. */
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  ownerPin!: string;
}
