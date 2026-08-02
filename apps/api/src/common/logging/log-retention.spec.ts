import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LOG_RETENTION_DEFAULT_DAYS, runLogRetention } from './log-retention';

/**
 * Unit tests for the startup retention sweep (Monitoring Architecture §3,
 * ruling B1(a)): the 14-day boundary semantics, the R5 safety guard that
 * ONLY AppLogger-named daily files are ever touched, the configurable
 * retention window, and the best-effort behavior when the directory does
 * not exist yet (first boot before the logger has created it).
 */
describe('runLogRetention', () => {
  let directory: string;

  const stampDaysAgo = (daysAgo: number): string => {
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const touch = (name: string): void => {
    fs.writeFileSync(path.join(directory, name), 'log line\n');
  };

  const remaining = (): string[] => fs.readdirSync(directory).sort();

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'log-retention-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('deletes daily log files older than the retention window and reports them', async () => {
    touch(`app-${stampDaysAgo(20)}.log`);
    touch(`app-${stampDaysAgo(15)}.log`);

    const deleted = await runLogRetention(directory, LOG_RETENTION_DEFAULT_DAYS);

    expect(deleted.sort()).toEqual([`app-${stampDaysAgo(15)}.log`, `app-${stampDaysAgo(20)}.log`].sort());
    expect(remaining()).toEqual([]);
  });

  it('preserves files inside the window, including one exactly at the 14-day boundary', async () => {
    touch(`app-${stampDaysAgo(0)}.log`);
    touch(`app-${stampDaysAgo(13)}.log`);
    touch(`app-${stampDaysAgo(14)}.log`); // boundary day is still kept
    touch(`app-${stampDaysAgo(15)}.log`); // one day beyond — swept

    const deleted = await runLogRetention(directory, 14);

    expect(deleted).toEqual([`app-${stampDaysAgo(15)}.log`]);
    expect(remaining()).toEqual(
      [`app-${stampDaysAgo(0)}.log`, `app-${stampDaysAgo(13)}.log`, `app-${stampDaysAgo(14)}.log`].sort(),
    );
  });

  it('the R5 guard never touches anything that is not an AppLogger daily file, however old', async () => {
    touch('notes.txt');
    touch('app-2020-1-1.log'); // not the zero-padded daily naming
    touch('app-1999-01-01.log.bak');
    touch('smarttable.db'); // the database must never be swept even if co-located
    touch(`app-${stampDaysAgo(30)}.log`); // the one eligible file

    const deleted = await runLogRetention(directory, 14);

    expect(deleted).toEqual([`app-${stampDaysAgo(30)}.log`]);
    expect(remaining()).toEqual(['app-1999-01-01.log.bak', 'app-2020-1-1.log', 'notes.txt', 'smarttable.db']);
  });

  it('honours a custom retention window', async () => {
    touch(`app-${stampDaysAgo(2)}.log`);
    touch(`app-${stampDaysAgo(1)}.log`);

    const deleted = await runLogRetention(directory, 1);

    expect(deleted).toEqual([`app-${stampDaysAgo(2)}.log`]);
    expect(remaining()).toEqual([`app-${stampDaysAgo(1)}.log`]);
  });

  it('returns an empty list when the log directory does not exist yet (first boot)', async () => {
    const deleted = await runLogRetention(path.join(directory, 'not-created-yet'), 14);
    expect(deleted).toEqual([]);
  });

  it('defaults to the §3 14-day window when no override is given', async () => {
    touch(`app-${stampDaysAgo(30)}.log`);

    const deleted = await runLogRetention(directory);

    expect(deleted).toEqual([`app-${stampDaysAgo(30)}.log`]);
  });
});
