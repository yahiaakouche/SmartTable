/**
 * Halls & tables contract types — API Contract Design §3/§6.
 * TableStatus values are the literal CHECK-constrained strings (Database
 * Schema Design, Appendix A) defined in enums.ts.
 */
import { TableStatus } from './enums';

export interface HallDto {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface TableDto {
  id: string;
  hallId: string;
  label: string;
  /** Cryptographically random, non-sequential public ordering token (FR35).
   * Exposed to staff for QR management; it is NOT the table's primary key. */
  qrToken: string;
  status: TableStatus;
  isActive: boolean;
  updatedAt: number;
}

export interface CreateHallRequest {
  name: string;
  sortOrder?: number;
}

export interface CreateTableRequest {
  label: string;
  hallId: string;
}

export interface UpdateTableRequest {
  label?: string;
  hallId?: string;
}
