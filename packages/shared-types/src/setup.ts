/**
 * Setup Wizard domain — API Contract Design §3 `setup-wizard`.
 * The one-time first-run bootstrap (FR15/FR16, PRD §1.2, NFR9) as it
 * crosses the API/frontend boundary.
 *
 * Step 3.11.
 */
import type { RestaurantProfileDto } from './config';
import type { EmployeeDto } from './auth';
import type { HallDto, TableDto } from './tables';

/**
 * GET /setup/status response — "Has setup been completed?" The contract
 * freezes this endpoint as the signal driving the Host's first-launch
 * branch. `completedAt` is the profile's `setup_completed_at` (Database
 * Schema Design §1) — null until the wizard commits (D3).
 */
export interface SetupStatusResponse {
  completed: boolean;
  completedAt: number | null;
}

/**
 * POST /setup/complete request — submits ALL wizard steps atomically:
 * profile, first table batch, first Owner account (the contract's frozen
 * tuple). Sent as multipart so the logo travels in the same call through
 * the Security §6 pipeline — which is why the shape is FLAT: multipart
 * form fields are scalar strings, so the Owner credentials are the three
 * `owner*` fields rather than a nested object.
 *
 * Step 3.11 rulings baked into this shape:
 *  - B2(a): `tableCount` only — the server creates one "Main Hall" plus
 *    "Table 1"…"Table N", each with its FR16 QR token; halls/tables are
 *    Owner-reorganizable afterwards via the existing tables endpoints.
 *  - B3(a): no menu payload — optional initial menu creation (FR17)
 *    happens after completion + login through the existing authenticated
 *    menu endpoints.
 *  - B4(a): the first Owner sets BOTH credentials, exactly like invitation
 *    acceptance (FR27): password (min 8) and PIN (4–6 digits).
 *  - D6: no `taxRatePercent` and no `email` — neither appears in FR15;
 *    tax stays the DB default 0 until changed via /config/restaurant-profile.
 */
export interface CompleteSetupRequest {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  /** Optional — FR15 default is DZD. */
  currencyCode?: string;
  /** Optional — FR15 default is Arabic. */
  defaultLanguage?: 'ar' | 'fr';
  tableCount: number;
  ownerName: string;
  ownerPassword: string;
  ownerPin: string;
}

/**
 * POST /setup/complete response — everything the atomic transaction
 * created, in the existing DTO vocabularies (D11). Deliberately carries
 * NO auth tokens: the client immediately calls /auth/password-login,
 * which already issues device trust (Security §1).
 */
export interface CompleteSetupResponse {
  profile: RestaurantProfileDto;
  owner: EmployeeDto;
  hall: HallDto;
  tables: TableDto[];
}
