/**
 * Jest setup file — executed before any test module is loaded.
 *
 * The fail-fast configuration schema (Step 3.0) validates environment
 * variables at ConfigModule load time, so the required variables must
 * exist before any application module is imported by a test.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smarttable-test-env-'));

process.env.DATABASE_FILE_PATH = path.join(scratch, 'test.db');
process.env.HTTP_PORT = '13080';
process.env.HTTPS_PORT = '13443';
process.env.JWT_SIGNING_KEY = 'test-only-signing-key-not-for-production';
// Step 3.14 (D7) — required by the config schema (strict MAJOR.MINOR.PATCH);
// specs send their own fresh header values, never a real product version.
process.env.APP_VERSION = '0.0.0';
process.env.LOG_DIRECTORY = path.join(scratch, 'logs');
process.env.BACKUP_DIRECTORY = path.join(scratch, 'backups');
process.env.UPLOAD_DIRECTORY = path.join(scratch, 'uploads');
