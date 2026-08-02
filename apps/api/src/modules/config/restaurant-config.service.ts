import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantProfileDto } from '@smarttable/shared-types';
import { DomainEventsService, RestaurantProfileChangedPayload } from '../../common/events/domain-events.service';
import { EntityNotFoundException, ValidationFailedException } from '../../common/exceptions/domain.exception';
import { AuditService } from '../audit/audit.service';
import { ImageStorageService } from '../menu/image-storage.service';
import {
  CONFIG_REPOSITORY,
  ConfigRepository,
  RestaurantProfileChanges,
  RestaurantProfileRow,
} from './restaurant-config.repository';
import { UpdateRestaurantProfileDto } from './dto/update-restaurant-profile.dto';

/**
 * Config domain (branding/settings) — Step 3.10 (API Contract §3 `config`,
 * FR31, Security §6).
 *
 * The profile is THE single logical row (Database Schema Design §1). Its
 * creation belongs exclusively to the future Setup Wizard (ruling B3(a)):
 * until that row exists, both endpoints answer 404 — this module never
 * creates it. Writes are deliberately conservative:
 *  - D3: only EFFECTIVE changes are written, audited, and broadcast — a
 *    PATCH restating current values is a literal no-op (200, current DTO),
 *    and a PATCH carrying no field and no file is a 400;
 *  - D4: the logo runs through the SAME Security §6 pipeline as product
 *    images (ImageStorageService, reused verbatim); the old file is
 *    released only after the replacement commits;
 *  - D7: `restaurant_profile.changed` is emitted only AFTER the write
 *    commits (Contract §4's binding rule), payload = the full updated
 *    profile DTO exactly as §4 freezes it;
 *  - D8: the change is audited with old/new values of the changed fields
 *    only — the tax rate is money-affecting, and FR38's frozen list
 *    predates this module (the Step 3.9 D8 precedent).
 */
@Injectable()
export class RestaurantConfigService {
  constructor(
    @Inject(CONFIG_REPOSITORY) private readonly configRepository: ConfigRepository,
    private readonly imageStorage: ImageStorageService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditService,
  ) {}

  /** Nullable read for trusted internal consumers (B2(a): the tables
   * module's public customer menu) — the row legitimately does not exist on
   * a fresh install, and those consumers must not fail over it. */
  async findProfileOrNull(): Promise<RestaurantProfileDto | null> {
    const row = await this.configRepository.findProfile();
    return row ? this.toDto(row) : null;
  }

  /** GET /config/restaurant-profile (D6: all staff roles). */
  async getProfile(): Promise<RestaurantProfileDto> {
    const profile = await this.findProfileOrNull();
    if (!profile) throw new EntityNotFoundException('restaurant_profile', 'singleton');
    return profile;
  }

  /** PATCH /config/restaurant-profile (B1(a): Owner only), optional `logo`
   * file part in the same multipart call (Security §6). */
  async updateProfile(actorEmployeeId: string, dto: UpdateRestaurantProfileDto, logoBuffer?: Buffer): Promise<RestaurantProfileDto> {
    const row = await this.configRepository.findProfile();
    if (!row) throw new EntityNotFoundException('restaurant_profile', 'singleton');

    const anyFieldProvided = Object.values(dto).some((value) => value !== undefined);
    if (!anyFieldProvided && !logoBuffer) {
      throw new ValidationFailedException('At least one profile field or a logo file is required.');
    }

    // D3 — keep only fields whose value actually changes.
    const changes: RestaurantProfileChanges = {};
    if (dto.name !== undefined && dto.name !== row.name) changes.name = dto.name;
    if (dto.primaryColor !== undefined && dto.primaryColor !== row.primaryColor) changes.primaryColor = dto.primaryColor;
    if (dto.secondaryColor !== undefined && dto.secondaryColor !== row.secondaryColor) changes.secondaryColor = dto.secondaryColor;
    if (dto.currencyCode !== undefined && dto.currencyCode !== row.currencyCode) changes.currencyCode = dto.currencyCode;
    if (dto.taxRatePercent !== undefined && dto.taxRatePercent !== row.taxRatePercent) changes.taxRatePercent = dto.taxRatePercent;
    if (dto.defaultLanguage !== undefined && dto.defaultLanguage !== row.defaultLanguage) changes.defaultLanguage = dto.defaultLanguage;

    // D4 — validate + store the new logo FIRST: if the §6 pipeline rejects
    // it, the row, the broadcast, and the audit trail all stand untouched.
    // (uuidv7 filename ⇒ always an effective change, never a no-op orphan.)
    let storedLogo: string | null = null;
    if (logoBuffer) {
      storedLogo = await this.imageStorage.validateAndStore(logoBuffer);
      changes.logoPath = storedLogo;
    }

    if (Object.keys(changes).length === 0) {
      return this.toDto(row); // true no-op — no write, no audit, no broadcast
    }

    const updated = await this.configRepository.updateProfile(row.id, changes);

    // Release the superseded file only AFTER the replacement commits (D4).
    // An orphaned file never fails the operation (ImageStorageService's
    // documented no-op; the Host disk-space check is the backstop).
    if (storedLogo && row.logoPath) {
      await this.imageStorage.deleteStored(row.logoPath);
    }

    const changedKeys = Object.keys(changes) as Array<keyof RestaurantProfileChanges>;
    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const key of changedKeys) {
      oldValues[key] = row[key];
      newValues[key] = updated[key];
    }
    await this.audit.append({
      actorEmployeeId,
      entityType: 'restaurant_profile',
      entityId: row.id,
      action: 'profile_updated',
      oldValueJson: JSON.stringify(oldValues),
      newValueJson: JSON.stringify(newValues),
    });

    // D7 — after the commit, with the full updated DTO (Contract §4).
    const result = this.toDto(updated);
    this.events.emitRestaurantProfileChanged({ ...result } as RestaurantProfileChangedPayload);
    return result;
  }

  private toDto(row: RestaurantProfileRow): RestaurantProfileDto {
    return {
      id: row.id,
      name: row.name,
      logoPath: row.logoPath,
      primaryColor: row.primaryColor,
      secondaryColor: row.secondaryColor,
      currencyCode: row.currencyCode,
      taxRatePercent: row.taxRatePercent,
      defaultLanguage: row.defaultLanguage as RestaurantProfileDto['defaultLanguage'],
      setupCompletedAt: row.setupCompletedAt,
      updatedAt: row.updatedAt,
    };
  }
}
