import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_CLIENT } from '../../database/database.module';
import type { DbClient } from '../../database/connection';
import { restaurantProfile } from '../../database/schema';

export const CONFIG_REPOSITORY = Symbol('CONFIG_REPOSITORY');

export type RestaurantProfileRow = typeof restaurantProfile.$inferSelect;

/** The fields this module may ever write (D10: `setupCompletedAt` is the
 * future Setup Wizard's alone; `id`/`updatedAt` are never client input). */
export interface RestaurantProfileChanges {
  name?: string;
  logoPath?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  currencyCode?: string;
  taxRatePercent?: number;
  defaultLanguage?: 'ar' | 'fr';
}

export interface ConfigRepository {
  /** THE single logical row (Database Schema Design §1), or null before the
   * Setup Wizard creates it. LIMIT 1 — the same tolerant read billing and
   * analytics already use (D11). */
  findProfile(): Promise<RestaurantProfileRow | null>;
  updateProfile(id: string, changes: RestaurantProfileChanges): Promise<RestaurantProfileRow>;
}

@Injectable()
export class DrizzleConfigRepository implements ConfigRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DbClient) {}

  async findProfile(): Promise<RestaurantProfileRow | null> {
    const rows = await this.db.select().from(restaurantProfile).limit(1);
    return rows[0] ?? null;
  }

  async updateProfile(id: string, changes: RestaurantProfileChanges): Promise<RestaurantProfileRow> {
    const rows = await this.db
      .update(restaurantProfile)
      .set({ ...changes, updatedAt: Date.now() })
      .where(eq(restaurantProfile.id, id))
      .returning();
    return rows[0];
  }
}
