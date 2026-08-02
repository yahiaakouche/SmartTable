import { ResourcesService } from './resources.service';

/**
 * Unit tests for the resources service (Step 3.12, D2/D8): the frozen D2
 * payload shape against the REAL os module, the data-volume disk probe,
 * and the rule that a failed disk probe yields `disk: null` rather than a
 * failed endpoint.
 */
describe('ResourcesService', () => {
  const serviceWith = (databaseFilePath: string) => {
    const config = { get: jest.fn().mockReturnValue(databaseFilePath) };
    return new ResourcesService(config as never);
  };

  it('returns the full D2 shape: live CPU/memory figures and the data-volume disk snapshot', async () => {
    const resources = await serviceWith(`${process.cwd()}/smarttable.db`).getResources();

    expect(resources.cpu.coreCount).toBeGreaterThan(0);
    expect(resources.cpu.loadAverage).toHaveLength(3);
    for (const value of resources.cpu.loadAverage) expect(value).toEqual(expect.any(Number));

    expect(resources.memory.totalBytes).toBeGreaterThan(0);
    expect(resources.memory.freeBytes).toBeGreaterThan(0);
    expect(resources.memory.processRssBytes).toBeGreaterThan(0);

    expect(resources.disk).not.toBeNull();
    expect(resources.disk!.totalBytes).toBeGreaterThan(0);
    expect(resources.disk!.freeBytes).toBeGreaterThan(0);
    expect(resources.disk!.usedPercent).toBeGreaterThanOrEqual(0);
    expect(resources.disk!.usedPercent).toBeLessThanOrEqual(100);

    expect(resources.collectedAt).toEqual(expect.any(Number));
  });

  it('a failed disk probe yields disk: null — the endpoint still answers (D2)', async () => {
    const resources = await serviceWith('/nonexistent-volume-xyz/smarttable.db').getResources();
    expect(resources.disk).toBeNull();
    expect(resources.cpu.coreCount).toBeGreaterThan(0); // the rest of the payload is intact
  });
});
