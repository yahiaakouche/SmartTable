import { EmployeeRole, InvitationStatus } from './enums';

/**
 * Contract DTOs for the auth / employees / invitations slice — the shapes
 * that cross the API/frontend boundary (Engineering Standards §1).
 * Class-based validation versions live in each module's dto/ folder; these
 * are the plain contract types both sides import.
 */

export interface EmployeeSummary {
  id: string;
  name: string;
  role: EmployeeRole;
}

/** Auth transport (API Contract Design §1): 15-min acting-employee JWT. */
export interface AuthTokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  employee: EmployeeSummary;
}

/** PIN login on an already-trusted device (`POST /auth/pin-login`). */
export interface PinLoginRequest {
  deviceRefreshToken: string;
  employeeId: string;
  pin: string;
}

/** Full login on a new/untrusted device (`POST /auth/password-login`). */
export interface PasswordLoginRequest {
  name: string;
  password: string;
}

/** Device trust exchange (`POST /auth/refresh`). */
export interface RefreshTokenRequest {
  refreshToken: string;
}

/** Full login also establishes Device Trust for the new device (Security §1). */
export interface PasswordLoginResponse extends AuthTokenResponse {
  deviceRefreshToken: string;
}

export interface EmployeeDto {
  id: string;
  name: string;
  role: EmployeeRole;
  email: string | null;
  isActive: boolean;
  lastLoginAt: number | null;
  createdAt: number;
  /** FR28 — latest invitation state for the Owner's roster screen. */
  invitationStatus: InvitationStatus | null;
}

export interface CreateEmployeeRequest {
  name: string;
  role: EmployeeRole;
  email?: string;
}

/** POST /employees response — the raw invitation token is shown exactly once. */
export interface CreateEmployeeResponse {
  employee: EmployeeDto;
  invitation: {
    id: string;
    token: string;
    expiresAt: number;
  };
}

export interface UpdateEmployeeRequest {
  role?: EmployeeRole;
  isActive?: boolean;
}

export interface ResetPinRequest {
  newPin: string;
}

/** Active Devices screen (Security Architecture §1). */
export interface DeviceDto {
  id: string;
  deviceLabel: string;
  lastUsedAt: number;
  createdAt: number;
}

/** GET /invitations/accept/:token — pre-account-creation context. */
export interface InvitationContextDto {
  employeeName: string;
  role: EmployeeRole;
  expiresAt: number;
}

/** POST /invitations/accept/:token — FR27: password + PIN set at acceptance. */
export interface AcceptInvitationRequest {
  password: string;
  pin: string;
  deviceLabel: string;
}

/** Acceptance establishes Device Trust for this device immediately (Security §1). */
export interface AcceptInvitationResponse extends AuthTokenResponse {
  deviceRefreshToken: string;
}
