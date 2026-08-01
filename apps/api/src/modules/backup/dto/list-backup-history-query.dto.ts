import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** GET /backup/history — cursor pagination only; the contract freezes no
 * filters for this route (§3), so none are invented (D5/D14). */
export class ListBackupHistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
