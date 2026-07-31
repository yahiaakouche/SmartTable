import { Matches } from 'class-validator';

/** Owner-triggered PIN reset — 4–6 digits per Security Architecture §1. */
export class ResetPinDto {
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  newPin!: string;
}
