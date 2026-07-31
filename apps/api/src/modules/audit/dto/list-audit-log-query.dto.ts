import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/** GET /audit-log — cursor pagination plus exactly the four filters the
 * contract freezes (§3: entityType, entityId, actorEmployeeId, date range).
 * The date range is epoch-ms `from`/`to` (Step 3.8 ruling B2(a)); entity
 * filters are exact-match free strings — the write vocabulary is open by
 * design (Schema §7), so constraining reads to an enum would silently hide
 * entries written under a future entity type (D4). */
export class ListAuditLogQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  actorEmployeeId?: string;

  /** Epoch milliseconds, inclusive lower bound on created_at. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from?: number;

  /** Epoch milliseconds, inclusive upper bound on created_at. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to?: number;
}
