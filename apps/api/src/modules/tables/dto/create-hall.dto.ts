import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateHallDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
