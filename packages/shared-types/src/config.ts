/**
 * Config domain (branding/settings) — API Contract Design §3 `config`.
 * The single-row restaurant profile (Database Schema Design §1) as it
 * crosses the API/frontend boundary.
 *
 * Step 3.10.
 */

/**
 * GET /config/restaurant-profile response (and the PATCH response, and the
 * payload of the `restaurant_profile.changed` broadcast — Contract §4
 * freezes the event payload as "the full updated profile DTO").
 *
 * `taxRatePercent` stays integer basis points on the wire (1900 = 19.00%) —
 * the Contract §6 money rule applied to rates: formatting is a frontend
 * concern, never the backend's.
 */
export interface RestaurantProfileDto {
  id: string;
  name: string;
  logoPath: string | null;
  primaryColor: string;
  secondaryColor: string;
  currencyCode: string;
  taxRatePercent: number;
  defaultLanguage: 'ar' | 'fr';
  /** Written exclusively by the future Setup Wizard (Step 3.10 ruling
   * B3(a)/D10) — read-only through this module. */
  setupCompletedAt: number | null;
  updatedAt: number;
}

/**
 * Step 3.10 ruling B2(a): the customer-facing branding subset, added
 * additively to `PublicMenuDto` so the customer QR interface actually
 * receives branding (FR31's customer half). The logo reaches the customer
 * through the existing public /uploads/:filename endpoint — never binary
 * in the payload.
 */
export interface RestaurantBrandingDto {
  name: string;
  logoPath: string | null;
  primaryColor: string;
  secondaryColor: string;
  currencyCode: string;
  defaultLanguage: 'ar' | 'fr';
}
