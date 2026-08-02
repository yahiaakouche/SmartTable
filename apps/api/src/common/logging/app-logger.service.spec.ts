import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppLogger } from './app-logger.service';
import { runWithCorrelationId } from './request-context';

/**
 * Unit tests for the application logger (Monitoring Architecture §2,
 * Step 3.13): the frozen mandatory field set on every JSON line, the
 * per-module stamping, the correlation ID from the request context (and
 * the stable process fallback outside it), the debug-off-by-default level
 * filtering, the daily file naming, and the R1 rule that a write failure
 * degrades to the console instead of ever throwing.
 */
describe('AppLogger', () => {
  let directory: string;
  let consoleError: jest.SpyInstance;

  const loggerWith = (overrides: Record<string, string> = {}, moduleName = 'test-module') => {
    const values: Record<string, string> = { LOG_DIRECTORY: directory, LOG_LEVEL: 'info', ...overrides };
    const config = { get: (key: string) => values[key] };
    return new AppLogger(config as never).child(moduleName);
  };

  const todayFile = () => {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return path.join(directory, `app-${stamp}.log`);
  };

  /** Writes are fire-and-forget by design; tests flush via a short poll. */
  const readLines = async (): Promise<Array<Record<string, unknown>>> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (fs.existsSync(todayFile()) && fs.readFileSync(todayFile(), 'utf8').trim().length > 0) {
        return fs
          .readFileSync(todayFile(), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('log file never appeared');
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-logger-test-'));
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('writes one JSON line per event with the §2 mandatory fields and the context object', async () => {
    const logger = loggerWith();
    runWithCorrelationId('corr-123', () => logger.info('something happened', { orderId: 'o1' }));

    const [line] = await readLines();
    expect(line).toEqual({
      timestamp: expect.any(Number),
      level: 'info',
      module: 'test-module',
      correlationId: 'corr-123',
      message: 'something happened',
      context: { orderId: 'o1' },
    });
  });

  it('stamps each line with its own module name via child loggers', async () => {
    const logger = loggerWith();
    logger.child('database').warn('slow query', { durationMs: 250 });
    logger.child('http').info('request done');

    const lines = await readLines();
    expect(lines.map((line) => line.module)).toEqual(['database', 'http']);
    expect(lines[0]).toMatchObject({ level: 'warn', correlationId: expect.any(String) });
  });

  it('outside request scope, lines share one stable process-level fallback ID', async () => {
    const logger = loggerWith();
    logger.info('first');
    logger.info('second');

    const lines = await readLines();
    expect(lines[0]!.correlationId).toEqual(lines[1]!.correlationId);
    expect(lines[0]!.correlationId).toEqual(expect.any(String));
  });

  it('debug is off by default at info level and emitted when LOG_LEVEL=debug (§2)', async () => {
    loggerWith().debug('hidden detail');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(todayFile())).toBe(false);

    loggerWith({ LOG_LEVEL: 'debug' }).debug('visible detail');
    const lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'debug', message: 'visible detail' });
  });

  it('error lines carry their stack trace inside the context object (§2)', async () => {
    loggerWith().error('Unhandled exception', { stack: 'Error: boom\n    at somewhere' });
    const [line] = await readLines();
    expect(line).toMatchObject({ level: 'error', context: { stack: expect.stringContaining('boom') } });
  });

  it('a write failure degrades to the console and never throws (R1)', async () => {
    const logger = loggerWith({ LOG_DIRECTORY: path.join(directory, 'blocked', 'file-as-dir') });
    // Make the log directory path impossible: a FILE where a dir is needed.
    fs.mkdirSync(path.join(directory, 'blocked'));
    fs.writeFileSync(path.join(directory, 'blocked', 'file-as-dir'), 'not a directory');

    expect(() => logger.info('will not reach the file')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[AppLogger] file write failed'),
      expect.stringContaining('will not reach the file'),
    );
  });
});
