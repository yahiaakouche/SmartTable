import type { Config } from 'drizzle-kit';

/**
 * Migrations are plain, version-controlled SQL files (Database Schema Design,
 * "Migration & Startup Integrity") — generated here, applied automatically by
 * the Host on startup, before migrations, per Backup & Resilience Architecture §5.
 */
export default {
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'sqlite',
} satisfies Config;
