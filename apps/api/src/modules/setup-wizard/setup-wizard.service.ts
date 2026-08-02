import { Inject, Injectable } from '@nestjs/common';
import { TableStatus } from '@smarttable/shared-types';
import type {
  CompleteSetupResponse,
  EmployeeDto,
  HallDto,
  RestaurantProfileDto,
  SetupStatusResponse,
  TableDto,
} from '@smarttable/shared-types';
import { SETUP_WIZARD_REPOSITORY, SetupWizardRepository } from './setup-wizard.repository';
import type { EmployeeRow, HallRow, TableRow } from './setup-wizard.repository';
import type { RestaurantProfileRow } from '../config/restaurant-config.repository';
import { RestaurantConfigService } from '../config/restaurant-config.service';
import { AuthService } from '../auth/auth.service';
import { ImageStorageService } from '../menu/image-storage.service';
import { AuditService } from '../audit/audit.service';
import { CompleteSetupDto } from './dto/complete-setup.dto';

/** B2(a)/D14 — the wizard asks only for a table count; this is the single
 * implicit hall the batch is created in. Renameable by the Owner at any
 * time via the existing halls endpoint (PRD §7 item 17). */
const DEFAULT_HALL_NAME = 'Main Hall';

/**
 * First-run Setup Wizard (FR15/FR16, PRD §1.2, NFR9) — the one-time
 * bootstrap that turns a fresh installation into a working restaurant.
 *
 * Frozen rules enforced here:
 *  - Both endpoints are PUBLIC (B1(a)) — no employee exists before setup,
 *    so no token can ever be presented. Protection is the one-shot guard
 *    (409 SETUP_ALREADY_COMPLETED) plus strict throttling on the route.
 *  - Creation of the restaurant_profile row is EXCLUSIVELY this module's
 *    (Step 3.10 ruling B3(a)) — the config module only reads/updates it.
 *  - The submission is atomic (B5(a)): profile + hall + table batch +
 *    first Owner commit in one transaction or not at all.
 *  - Credentials are Argon2id-hashed by AuthService BEFORE any write (R7)
 *    and never appear in audit rows (D9).
 *  - No realtime broadcasts (D10): creation ≠ change, and no staff token
 *    or QR listener can exist before setup completes.
 */
@Injectable()
export class SetupWizardService {
  constructor(
    @Inject(SETUP_WIZARD_REPOSITORY) private readonly setupRepository: SetupWizardRepository,
    private readonly configService: RestaurantConfigService,
    private readonly authService: AuthService,
    private readonly imageStorage: ImageStorageService,
    private readonly audit: AuditService,
  ) {}

  /** GET /setup/status — D3: `setupCompletedAt` is the semantic source.
   * The wizard is the only profile-creation path and always sets it, so
   * row existence and completion are equivalent in practice. */
  async getStatus(): Promise<SetupStatusResponse> {
    const profile = await this.configService.findProfileOrNull();
    return {
      completed: profile?.setupCompletedAt != null,
      completedAt: profile?.setupCompletedAt ?? null,
    };
  }

  /** POST /setup/complete — orchestration only; the atomicity itself is
   * the repository's single transaction (B5(a)). Ordering mirrors the
   * 3.10 logo discipline (D8): hash credentials and validate+store the
   * logo FIRST (both pure or reversible), then the transaction; on any
   * failure the freshly stored logo file is best-effort deleted so a
   * failed setup never leaves an orphan upload. */
  async completeSetup(dto: CompleteSetupDto, logoBuffer?: Buffer): Promise<CompleteSetupResponse> {
    const { passwordHash, pinHash } = await this.authService.hashCredentials(
      dto.ownerPassword,
      dto.ownerPin,
    );

    let storedLogo: string | null = null;
    if (logoBuffer) {
      storedLogo = await this.imageStorage.validateAndStore(logoBuffer);
    }

    try {
      const result = await this.setupRepository.completeTransaction({
        profile: {
          name: dto.name,
          logoPath: storedLogo,
          primaryColor: dto.primaryColor,
          secondaryColor: dto.secondaryColor,
          currencyCode: dto.currencyCode ?? 'DZD', // FR15 default
          defaultLanguage: dto.defaultLanguage ?? 'ar', // FR15 default
          setupCompletedAt: Date.now(),
        },
        hall: { name: DEFAULT_HALL_NAME, sortOrder: 0 },
        tables: Array.from({ length: dto.tableCount }, (_, index) => ({
          label: `Table ${index + 1}`,
        })),
        owner: { name: dto.ownerName, passwordHash, pinHash },
      });

      // D9 — the bootstrap is security-relevant (it creates the first
      // Owner), so it is audited; the actor is null by design (no employee
      // exists yet — the schema's actor column is nullable for exactly
      // this), and credential material never appears in the payload.
      await this.audit.append({
        actorEmployeeId: null,
        entityType: 'setup',
        entityId: result.profile.id,
        action: 'setup_completed',
        newValueJson: JSON.stringify({
          profileId: result.profile.id,
          hallId: result.hall.id,
          tableCount: result.tables.length,
          ownerEmployeeId: result.owner.id,
        }),
      });

      return {
        profile: this.profileToDto(result.profile),
        owner: this.employeeToDto(result.owner),
        hall: this.hallToDto(result.hall),
        tables: result.tables.map((row) => this.tableToDto(row)),
      };
    } catch (error) {
      if (storedLogo) {
        await this.imageStorage.deleteStored(storedLogo).catch(() => undefined);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------- DTO mapping
  // passwordHash/pinHash are structurally excluded (API Contract §6:
  // entities never serialize directly).

  private profileToDto(row: RestaurantProfileRow): RestaurantProfileDto {
    return {
      id: row.id,
      name: row.name,
      logoPath: row.logoPath,
      primaryColor: row.primaryColor,
      secondaryColor: row.secondaryColor,
      currencyCode: row.currencyCode,
      taxRatePercent: row.taxRatePercent,
      defaultLanguage: row.defaultLanguage as 'ar' | 'fr',
      setupCompletedAt: row.setupCompletedAt,
      updatedAt: row.updatedAt,
    };
  }

  private employeeToDto(row: EmployeeRow): EmployeeDto {
    return {
      id: row.id,
      name: row.name,
      role: row.role as EmployeeDto['role'],
      email: row.email,
      isActive: row.isActive,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      // The first Owner is created with credentials directly — there is
      // no invitation (FR27's acceptance flow is for LATER staff).
      invitationStatus: null,
    };
  }

  private hallToDto(row: HallRow): HallDto {
    return { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive };
  }

  private tableToDto(row: TableRow): TableDto {
    return {
      id: row.id,
      hallId: row.hallId,
      label: row.label,
      qrToken: row.qrToken,
      status: row.status as TableStatus,
      isActive: row.isActive,
      updatedAt: row.updatedAt,
    };
  }
}
