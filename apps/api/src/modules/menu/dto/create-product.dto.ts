import { IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * POST /products is multipart (API Contract §3) — text fields arrive as
 * strings, so numeric coercion happens at the DTO boundary before
 * validation. Money is an integer minor-unit value (FR36, ES §6); the
 * database CHECK (`price_minor >= 0`) remains the last line of defense.
 */
export class CreateProductDto {
  @IsString()
  @Length(1, 200)
  nameAr!: string;

  @IsString()
  @Length(1, 200)
  nameFr!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinor!: number;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
