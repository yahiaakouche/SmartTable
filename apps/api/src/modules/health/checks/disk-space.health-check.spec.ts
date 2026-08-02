import { DiskSpaceHealthCheck } from './disk-space.health-check';

jest.mock('fs/promises', () => ({ statfs: jest.fn() }));

import { statfs } from 'fs/promises';

const statfsMock = statfs as unknown as jest.Mock;

/**
 * Unit tests for the disk-space health check (Step 3.12 ruling B3(a)/D3):
 * the frozen threshold boundaries (degraded at 85% used — Monitoring §4's
 * own example figure — critical at 95%), the zero-size edge, and the rule
 * that a failed probe degrades rather than ever taking the diagnostics
 * endpoint down.
 */
describe('DiskSpaceHealthCheck', () => {
  let check: DiskSpaceHealthCheck;

  const volumeAt = (usedPercent: number) => {
    // bsize 4096 × 1000 blocks; bavail chosen so used% lands exactly.
    statfsMock.mockResolvedValue({
      bsize: 4096,
      blocks: 1000,
      bavail: Math.round(1000 * (1 - usedPercent / 100)),
    });
  };

  beforeEach(() => {
    statfsMock.mockReset();
    const config = { get: jest.fn().mockReturnValue('/data/smarttable.db') };
    check = new DiskSpaceHealthCheck(config as never);
  });

  it('reports healthy below 85% used, with the figure in the detail', async () => {
    volumeAt(84);
    await expect(check.check()).resolves.toEqual({ status: 'healthy', detail: '84% of the data volume is used' });
    // Probed the DATA volume (the database file's directory), not cwd.
    expect(statfsMock).toHaveBeenCalledWith('/data');
  });

  it('reports degraded from exactly 85% used (the document example threshold)', async () => {
    volumeAt(85);
    await expect(check.check()).resolves.toMatchObject({ status: 'degraded', detail: '85% of the data volume is used' });
    volumeAt(94);
    await expect(check.check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('reports critical from exactly 95% used', async () => {
    volumeAt(95);
    await expect(check.check()).resolves.toMatchObject({ status: 'critical', detail: '95% of the data volume is used' });
    volumeAt(99);
    await expect(check.check()).resolves.toMatchObject({ status: 'critical' });
  });

  it('a zero-size volume edge reports 0% rather than dividing by zero', async () => {
    statfsMock.mockResolvedValue({ bsize: 4096, blocks: 0, bavail: 0 });
    await expect(check.check()).resolves.toMatchObject({ status: 'healthy', detail: '0% of the data volume is used' });
  });

  it('a failed probe DEGRADES the aggregate — it never throws into the endpoint (R3)', async () => {
    statfsMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const result = await check.check();
    expect(result.status).toBe('degraded');
    expect(result.detail).toMatch(/disk probe failed: ENOENT/);
  });
});
