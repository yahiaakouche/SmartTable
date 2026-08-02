import Database from 'better-sqlite3';
import { instrumentSlowQueries, SLOW_QUERY_DEFAULT_THRESHOLD_MS } from './slow-query';

/**
 * Unit tests for slow-query flagging (Monitoring Architecture §7, ruling
 * B4(a)) against a real in-memory better-sqlite3 database: flagging above
 * the threshold with the SQL TEXT only (bound parameter VALUES never reach
 * the log — the never-logged list is a security requirement), silence below
 * it, and the R6 transparency of the wrapper (return values, raw()/iterate()
 * passthrough, exception behavior exactly as the unwrapped driver).
 */
describe('instrumentSlowQueries', () => {
  let sqlite: Database.Database;
  let flagged: Array<{ sqlText: string; durationMs: number }>;

  const onSlowQuery = (sqlText: string, durationMs: number): void => {
    flagged.push({ sqlText, durationMs });
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    flagged = [];
  });

  afterEach(() => {
    sqlite.close();
  });

  it('flags a statement slower than the threshold with its SQL text and rounded duration', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 0); // threshold 0 → everything is "slow"

    sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('chair');
    sqlite.prepare('SELECT * FROM items').all();

    expect(flagged).toHaveLength(2);
    expect(flagged[0]).toEqual({ sqlText: 'INSERT INTO items (name) VALUES (?)', durationMs: expect.any(Number) });
    expect(flagged[1]!.sqlText).toBe('SELECT * FROM items');
  });

  it('never flags statements at or below the threshold', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 60_000);

    sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('chair');
    sqlite.prepare('SELECT * FROM items').all();
    sqlite.prepare('SELECT * FROM items WHERE id = ?').get(1);

    expect(flagged).toEqual([]);
  });

  it('B4(a) — bound parameter values never reach the callback, only the SQL text', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 0);

    sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('secret-pin-1234');

    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.sqlText).toContain('?');
    expect(flagged[0]!.sqlText).not.toContain('secret-pin-1234');
  });

  it('truncates very long SQL text to the 1000-character context cap', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 0);

    const longSql = `SELECT * FROM items WHERE name != '${'x'.repeat(2_000)}'`;
    sqlite.prepare(longSql).all();

    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.sqlText).toHaveLength(1_000);
    expect(flagged[0]!.sqlText).toBe(longSql.slice(0, 1_000));
  });

  it('defaults to the §7 200 ms threshold when none is given', () => {
    expect(SLOW_QUERY_DEFAULT_THRESHOLD_MS).toBe(200);

    instrumentSlowQueries(sqlite, onSlowQuery);
    sqlite.prepare('SELECT * FROM items').all();

    expect(flagged).toEqual([]);
  });

  it('R6 — timed methods preserve return values exactly (run/get/all)', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 60_000);

    const runResult = sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('chair');
    expect(runResult.changes).toBe(1);
    expect(Number(runResult.lastInsertRowid)).toBe(1);

    const row = sqlite.prepare('SELECT id, name FROM items WHERE id = ?').get(1);
    expect(row).toEqual({ id: 1, name: 'chair' });

    const rows = sqlite.prepare('SELECT * FROM items').all();
    expect(rows).toEqual([{ id: 1, name: 'chair' }]);
  });

  it('R6 — untouched methods pass through (raw/iterate/bind/columns)', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 60_000);
    sqlite.prepare('INSERT INTO items (name) VALUES (?)').run('chair');

    const rawRows = sqlite.prepare('SELECT name FROM items').raw().all();
    expect(rawRows).toEqual([['chair']]);

    const iterated = [...sqlite.prepare('SELECT name FROM items').iterate()] as Array<{ name: string }>;
    expect(iterated).toEqual([{ name: 'chair' }]);

    const columns = sqlite.prepare('SELECT id, name FROM items').columns();
    expect(columns.map((column) => column.name)).toEqual(['id', 'name']);
  });

  it('R6 — statement errors propagate unchanged, and a failing fast statement is not flagged', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 60_000);

    expect(() => sqlite.prepare('SELECT * FROM missing_table').all()).toThrow(/no such table/);
    expect(flagged).toEqual([]);
  });

  it('exec() and other connection-level methods keep working after instrumentation', () => {
    instrumentSlowQueries(sqlite, onSlowQuery, 60_000);

    sqlite.exec("INSERT INTO items (name) VALUES ('table')");
    const count = sqlite.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
