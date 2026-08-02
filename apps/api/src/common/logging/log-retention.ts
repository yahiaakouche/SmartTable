import { readdir, rm } from 'fs/promises';
import * as path from 'path';

/** Monitoring Architecture §3's default — overridable per installation
 * via LOG_RETENTION_DAYS; Owner-configurable through the Host's
 * Diagnostics UI in the Host phase (future note, not built). */
export const LOG_RETENTION_DEFAULT_DAYS = 14;

/** The safety guard (R5): ONLY files produced by AppLogger's daily naming
 * are ever eligible — the sweep can never touch the database, backups,
 * uploads, or any unrelated file that happens to share the directory. */
const LOG_FILE_PATTERN = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * Monitoring Architecture §3 — the retention half of the rotation policy
 * (ruling B1(a)): daily files are the rotation; this startup sweep is the
 * deletion that actually bounds disk growth. Compression is deliberately
 * deferred. Runs once at module init; retention applies ONLY to
 * Application Logs — the Audit Log and Order Status Events are permanent
 * by product decision (NFR15/NFR16) and live in the database, untouched.
 *
 * Best-effort per file (R1): one unreadable directory entry must never
 * abort the sweep, let alone the boot.
 */
export async function runLogRetention(logDirectory: string, retentionDays: number = LOG_RETENTION_DEFAULT_DAYS): Promise<string[]> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffStamp = dateStamp(cutoff);

  let entries: string[];
  try {
    entries = await readdir(logDirectory);
  } catch {
    return []; // directory doesn't exist yet — nothing to sweep
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    const match = LOG_FILE_PATTERN.exec(entry);
    if (!match) continue; // the guard — anything else is left exactly as found
    const fileStamp = `${match[1]}-${match[2]}-${match[3]}`;
    if (fileStamp >= cutoffStamp) continue; // string compare IS date compare in ISO form
    try {
      await rm(path.join(logDirectory, entry));
      deleted.push(entry);
    } catch {
      // One stubborn file never aborts the sweep.
    }
  }
  return deleted;
}

function dateStamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
