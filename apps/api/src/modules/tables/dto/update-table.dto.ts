import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class UpdateTableDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  label?: string;

  @IsOptional()
  @IsUUID()
  hallId?: string;
}
