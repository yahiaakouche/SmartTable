import { IsString, IsUUID, Length } from 'class-validator';

export class CreateTableDto {
  @IsString()
  @Length(1, 200)
  label!: string;

  /** Shape validated here; existence + active status at the service (ES §6). */
  @IsUUID()
  hallId!: string;
}
