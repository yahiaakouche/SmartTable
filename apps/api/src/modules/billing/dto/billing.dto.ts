import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';

/** POST /payments — references the Table Bill Group (Contract §3). The amount
 * is deliberately ABSENT: it is server-computed from the bill (ruling D2) and
 * any client-supplied amount is rejected as a non-whitelisted field. */
export class RecordPaymentDto {
  @IsUUID()
  tableBillGroupId!: string;
}

/** POST /shifts/open — money fields are integer minor units at the DTO layer
 * itself (ES §6, FR36). Zero opening cash is legitimate (empty drawer start). */
export class OpenShiftDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  openingCashMinor!: number;
}

/** POST /shifts/:id/close — the counted drawer total. */
export class CloseShiftDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  closingCashMinor!: number;
}
