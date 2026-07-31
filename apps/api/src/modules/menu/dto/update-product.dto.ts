import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * PATCH /products/:id — also accepted as multipart so an image can be
 * replaced in the same call. Boolean/number coercion mirrors the create DTO.
 */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameFr?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinor?: number;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
