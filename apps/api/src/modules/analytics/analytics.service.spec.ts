import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository, OrderItemRow, OrderRow, StatusEventRow } from './analytics.repository';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the analytics rules (Engineering Standards §10 — money-
 * adjacent logic is a mandatory unit-test surface):
 *  - B5(a): the complete range vocabulary + custom-range validation,
 *  - the frozen hybrid branching (today live / past rollups / spanning
 *    ranges merged; employeeId → the raw collecting-employee path),
 *  - D1 derivations: AOV rounding/null, cancellation-rate nulls, tie-breaks,
 *    peak hour/day, prep-time/turnover means, revenue-by-shift grouping,
 *  - D2 series granularity + zero-filling,
 *  - B3(a)/FR43: neutral operational stats (name-sorted, no rankings).
 */
describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let repository: jest.Mocked<AnalyticsRepository>;

  const MS_PER_DAY = 86_400_000;
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayStart = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getTime();
  };
  const today = fmt(Date.now());
  const yesterday = fmt(dayStart(today) - MS_PER_DAY);
  const twoDaysAgo = fmt(dayStart(today) - 2 * MS_PER_DAY);

  const eventRow = (overrides: Partial<StatusEventRow> = {}): StatusEventRow => ({
    id: 'ev-1',
    orderId: 'order-1',
    fromStatus: 'preparing',
    toStatus: 'ready',
    actorEmployeeId: null,
    createdAt: 1000,
    ...overrides,
  });

  const orderRow = (overrides: Partial<OrderRow> = {}): OrderRow => ({
    id: 'order-1',
    tableBillGroupId: 'group-1',
    tableId: 'table-1',
    channel: 'dine_in',
    isAddon: false,
    status: 'completed',
    source: 'qr',
    createdByEmployeeId: null,
    acceptedByEmployeeId: null,
    servedByEmployeeId: null,
    cancelledByEmployeeId: null,
    cancellationReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  const itemRow = (overrides: Partial<OrderItemRow> = {}): OrderItemRow => ({
    id: 'item-1',
    orderId: 'order-1',
    productId: 'product-1',
    nameSnapshot: 'شوربة عدس',
    categorySnapshot: 'مقبلات',
    unitPriceMinorSnapshot: 25000,
    quantity: 2,
    notes: null,
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      findDailyRollupRows: jest.fn().mockResolvedValue([]),
      findHourlyRollupRows: jest.fn().mockResolvedValue([]),
      findProductRollupRows: jest.fn().mockResolvedValue([]),
      findEventsByStatusInWindow: jest.fn().mockResolvedValue([]),
      findActorEventsInWindow: jest.fn().mockResolvedValue([]),
      findEventsByOrderIdsAndStatus: jest.fn().mockResolvedValue([]),
      findOrdersByIds: jest.fn().mockResolvedValue([]),
      findOrdersByBillGroupIds: jest.fn().mockResolvedValue([]),
      findItemsByOrderIds: jest.fn().mockResolvedValue([]),
      findPaymentsInWindow: jest.fn().mockResolvedValue([]),
      findPaymentsByBillGroupIds: jest.fn().mockResolvedValue([]),
      findShiftsByIds: jest.fn().mockResolvedValue([]),
      findClosedBillGroupsInWindow: jest.fn().mockResolvedValue([]),
      countActiveTables: jest.fn().mockResolvedValue(0),
      findActiveKitchenWaiterStaff: jest.fn().mockResolvedValue([]),
      getTaxRateBasisPoints: jest.fn().mockResolvedValue(0),
    } as jest.Mocked<AnalyticsRepository>;
    service = new AnalyticsService(repository);
  });

  describe('range resolution (B5(a))', () => {
    it('defaults to today when nothing is given', async () => {
      const result = await service.getKpis({});
      expect(result.range).toEqual({ from: today, to: today });
      // today-only → live path only, no rollup reads
      expect(repository.findDailyRollupRows).not.toHaveBeenCalled();
    });

    it('resolves the full named vocabulary against the server-local calendar', async () => {
      const cases: [string, string, string][] = [
        ['yesterday', yesterday, yesterday],
        ['last7Days', fmt(dayStart(today) - 6 * MS_PER_DAY), today],
        ['last30Days', fmt(dayStart(today) - 29 * MS_PER_DAY), today],
        ['thisMonth', `${today.slice(0, 7)}-01`, today],
        ['thisYear', `${today.slice(0, 4)}-01-01`, today],
      ];
      for (const [range, from, to] of cases) {
        const result = await service.getKpis({ range: range as never });
        expect(result.range).toEqual({ from, to });
      }
      const lastMonth = await service.getKpis({ range: 'lastMonth' });
      expect(lastMonth.range.from.endsWith('-01')).toBe(true);
      expect(lastMonth.range.to < lastMonth.range.from.slice(0, 7) + '-32' && lastMonth.range.to >= lastMonth.range.from).toBe(true);
      expect(lastMonth.range.to < today.slice(0, 7) + '-01' || lastMonth.range.to.slice(0, 7) < today.slice(0, 7)).toBe(true);
    });

    it('accepts an inclusive custom range', async () => {
      const result = await service.getKpis({ range: 'custom', from: twoDaysAgo, to: yesterday });
      expect(result.range).toEqual({ from: twoDaysAgo, to: yesterday });
      // Entirely in the past → rollup path only, no live reads.
      expect(repository.findDailyRollupRows).toHaveBeenCalledWith(twoDaysAgo, yesterday);
      expect(repository.findEventsByStatusInWindow).not.toHaveBeenCalledWith('completed', expect.anything(), expect.anything());
    });

    it('rejects custom without both dates, from/to with a named range, inverted and impossible dates', async () => {
      await expect(service.getKpis({ range: 'custom', from: yesterday })).rejects.toBeInstanceOf(ValidationFailedException);
      await expect(service.getKpis({ range: 'today', from: yesterday, to: today })).rejects.toBeInstanceOf(ValidationFailedException);
      await expect(service.getKpis({ range: 'custom', from: today, to: yesterday })).rejects.toBeInstanceOf(ValidationFailedException);
      await expect(service.getKpis({ range: 'custom', from: '2025-02-30', to: '2025-03-01' })).rejects.toBeInstanceOf(
        ValidationFailedException,
      );
    });

    it('treats from+to without a range as custom', async () => {
      const result = await service.getKpis({ from: yesterday, to: yesterday });
      expect(result.range).toEqual({ from: yesterday, to: yesterday });
    });
  });

  describe('hybrid branching and KPI derivations (D1)', () => {
    it('today-only reads live facts and derives the KPI set from them', async () => {
      repository.findEventsByStatusInWindow.mockImplementation(async (toStatus: string) =>
        toStatus === 'completed' ? [eventRow({ orderId: 'order-1', createdAt: dayStart(today) + 10 * 3_600_000 })] : [],
      );
      repository.findOrdersByIds.mockResolvedValue([orderRow()]);
      repository.findItemsByOrderIds.mockResolvedValue([itemRow()]);
      repository.countActiveTables.mockResolvedValue(3);

      const result = await service.getKpis({});

      expect(repository.findDailyRollupRows).not.toHaveBeenCalled();
      expect(result.totalRevenueMinor).toBe(50000); // 2 × 25000, tax 0%
      expect(result.dineInRevenueMinor).toBe(50000);
      expect(result.deliveryRevenueMinor).toBe(0);
      expect(result.totalOrders).toBe(1);
      expect(result.averageOrderValueMinor).toBe(50000);
      expect(result.bestSellingProduct).toEqual({ name: 'شوربة عدس', quantitySold: 2 });
      expect(result.bestSellingCategory).toEqual({ name: 'مقبلات', quantitySold: 2 });
      expect(result.peakSalesHour).toEqual({ hour: 10, revenueMinor: 50000 });
      expect(result.peakSalesDay).toEqual({ date: today, revenueMinor: 50000 });
      expect(result.activeTables).toBe(3);
      expect(result.cancellationRate).toBe(0); // 1 completed, 0 cancelled → 0/1
      expect(result.categoryMix).toEqual([{ category: 'مقبلات', quantitySold: 2, revenueMinor: 50000 }]);
    });

    it('applies tax via the shared billing function (post-tax revenue)', async () => {
      repository.getTaxRateBasisPoints.mockResolvedValue(1900); // 19%
      repository.findEventsByStatusInWindow.mockImplementation(async (toStatus: string) =>
        toStatus === 'completed' ? [eventRow({ orderId: 'order-1', createdAt: Date.now() })] : [],
      );
      repository.findOrdersByIds.mockResolvedValue([orderRow()]);
      repository.findItemsByOrderIds.mockResolvedValue([itemRow({ unitPriceMinorSnapshot: 10000, quantity: 1 })]);

      const result = await service.getKpis({});
      expect(result.totalRevenueMinor).toBe(11900); // 10000 + round(19%) post-tax
      // Product revenue stays NET (pre-tax) — the 3.4 rollup definition.
      expect(result.categoryMix[0].revenueMinor).toBe(10000);
    });

    it('past-only ranges aggregate rollup rows (cancelled included)', async () => {
      repository.findDailyRollupRows.mockResolvedValue([
        { date: twoDaysAgo, totalRevenueMinor: 30000, dineInRevenueMinor: 30000, deliveryRevenueMinor: 0, totalOrders: 2, cancelledOrders: 1, updatedAt: 1 },
        { date: yesterday, totalRevenueMinor: 70000, dineInRevenueMinor: 70000, deliveryRevenueMinor: 0, totalOrders: 3, cancelledOrders: 1, updatedAt: 1 },
      ]);
      repository.findHourlyRollupRows.mockResolvedValue([
        { date: twoDaysAgo, hour: 12, revenueMinor: 30000, ordersCount: 2 },
        { date: yesterday, hour: 19, revenueMinor: 70000, ordersCount: 3 },
      ]);
      repository.findProductRollupRows.mockResolvedValue([
        { id: 'p1', date: yesterday, productNameSnapshot: 'كسكس', categorySnapshot: 'أطباق رئيسية', quantitySold: 5, revenueMinor: 70000 },
      ]);

      const result = await service.getKpis({ range: 'custom', from: twoDaysAgo, to: yesterday });

      expect(result.totalRevenueMinor).toBe(100000);
      expect(result.totalOrders).toBe(5);
      expect(result.averageOrderValueMinor).toBe(20000);
      expect(result.cancellationRate).toBeCloseTo(2 / 7, 4);
      expect(result.peakSalesHour).toEqual({ hour: 19, revenueMinor: 70000 });
      expect(result.peakSalesDay).toEqual({ date: yesterday, revenueMinor: 70000 });
      expect(result.bestSellingProduct).toEqual({ name: 'كسكس', quantitySold: 5 });
    });

    it('a range spanning today merges rollups and live facts with one semantics', async () => {
      repository.findDailyRollupRows.mockResolvedValue([
        { date: yesterday, totalRevenueMinor: 30000, dineInRevenueMinor: 30000, deliveryRevenueMinor: 0, totalOrders: 1, cancelledOrders: 0, updatedAt: 1 },
      ]);
      repository.findEventsByStatusInWindow.mockImplementation(async (toStatus: string) =>
        toStatus === 'completed' ? [eventRow({ orderId: 'order-live', createdAt: Date.now() })] : [],
      );
      repository.findOrdersByIds.mockResolvedValue([orderRow({ id: 'order-live' })]);
      repository.findItemsByOrderIds.mockResolvedValue([itemRow({ orderId: 'order-live', quantity: 2 })]);

      const result = await service.getKpis({ range: 'custom', from: yesterday, to: today });

      expect(repository.findDailyRollupRows).toHaveBeenCalledWith(yesterday, yesterday);
      expect(result.totalRevenueMinor).toBe(30000 + 50000);
      expect(result.totalOrders).toBe(2);
      expect(result.peakSalesDay).toEqual({ date: today, revenueMinor: 50000 });
    });

    it('employeeId switches to the collecting-employee raw path and nulls the cancellation rate (B2(a))', async () => {
      repository.findPaymentsInWindow.mockResolvedValue([
        { id: 'pay-1', tableBillGroupId: 'group-1', amountMinor: 50000, method: 'cash', collectedByEmployeeId: 'emp-cashier', shiftId: 'shift-1', createdAt: dayStart(yesterday) + 50_000 },
      ]);
      repository.findOrdersByBillGroupIds.mockResolvedValue([
        orderRow({ status: 'completed' }),
        orderRow({ id: 'order-2', status: 'cancelled' }), // excluded from facts
      ]);
      repository.findItemsByOrderIds.mockResolvedValue([itemRow()]);
      repository.findShiftsByIds.mockResolvedValue([
        { id: 'shift-1', employeeId: 'emp-cashier', openingCashMinor: 20000, closingCashMinor: null, expectedCashMinor: null, status: 'open', openedAt: dayStart(yesterday), closedAt: null },
      ]);

      const result = await service.getKpis({ range: 'custom', from: yesterday, to: yesterday, employeeId: 'emp-cashier' });

      expect(repository.findDailyRollupRows).not.toHaveBeenCalled();
      expect(repository.findPaymentsInWindow).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 'emp-cashier');
      expect(result.totalRevenueMinor).toBe(50000);
      expect(result.totalOrders).toBe(1);
      expect(result.cancellationRate).toBeNull(); // cancellations are not attributable to a collector
      expect(result.revenueByShift).toEqual([
        { shiftId: 'shift-1', employeeId: 'emp-cashier', openedAt: dayStart(yesterday), closedAt: null, revenueMinor: 50000 },
      ]);
    });

    it('AOV rounds half-up and is null on an empty range', async () => {
      repository.findDailyRollupRows.mockResolvedValue([
        { date: yesterday, totalRevenueMinor: 100001, dineInRevenueMinor: 100001, deliveryRevenueMinor: 0, totalOrders: 3, cancelledOrders: 0, updatedAt: 1 },
      ]);
      const withData = await service.getKpis({ range: 'custom', from: yesterday, to: yesterday });
      expect(withData.averageOrderValueMinor).toBe(33334); // round-half-up(100001/3)

      repository.findDailyRollupRows.mockResolvedValue([]);
      const empty = await service.getKpis({ range: 'custom', from: yesterday, to: yesterday });
      expect(empty.averageOrderValueMinor).toBeNull();
      expect(empty.bestSellingProduct).toBeNull();
      expect(empty.peakSalesHour).toBeNull();
      expect(empty.peakSalesDay).toBeNull();
      expect(empty.averagePreparationTimeMs).toBeNull();
      expect(empty.averageTableTurnoverMs).toBeNull();
    });

    it('computes mean preparation time and table turnover from raw facts', async () => {
      repository.findEventsByStatusInWindow.mockImplementation(async (toStatus: string, fromMs: number) => {
        if (toStatus === 'ready') {
          return [
            eventRow({ orderId: 'o1', createdAt: fromMs + 600_000 }),
            eventRow({ id: 'ev-2', orderId: 'o2', createdAt: fromMs + 900_000 }),
          ];
        }
        return [];
      });
      repository.findEventsByOrderIdsAndStatus.mockResolvedValue([
        eventRow({ orderId: 'o1', toStatus: 'accepted', createdAt: dayStart(yesterday) + 60_000 }),
        eventRow({ id: 'ev-3', orderId: 'o2', toStatus: 'accepted', createdAt: dayStart(yesterday) + 60_000 }),
      ]);
      repository.findClosedBillGroupsInWindow.mockResolvedValue([
        { id: 'g1', tableId: 't1', status: 'closed', openedAt: dayStart(yesterday), closedAt: dayStart(yesterday) + 3_600_000 },
        { id: 'g2', tableId: 't2', status: 'closed', openedAt: dayStart(yesterday), closedAt: dayStart(yesterday) + 1_800_000 },
      ]);

      const result = await service.getKpis({ range: 'custom', from: yesterday, to: yesterday });

      expect(result.averagePreparationTimeMs).toBe(690_000); // mean(540000, 840000)
      expect(result.averageTableTurnoverMs).toBe(2_700_000); // mean(3.6M, 1.8M)
    });

    it('revenueByShift groups payments by shift (null shift last, chronological)', async () => {
      repository.findPaymentsInWindow.mockResolvedValue([
        { id: 'p1', tableBillGroupId: 'g1', amountMinor: 40000, method: 'cash', collectedByEmployeeId: 'e1', shiftId: 'shift-2', createdAt: 1 },
        { id: 'p2', tableBillGroupId: 'g2', amountMinor: 60000, method: 'cash', collectedByEmployeeId: 'e1', shiftId: 'shift-1', createdAt: 2 },
        { id: 'p3', tableBillGroupId: 'g3', amountMinor: 5000, method: 'cash', collectedByEmployeeId: 'e2', shiftId: null, createdAt: 3 },
        { id: 'p4', tableBillGroupId: 'g4', amountMinor: 10000, method: 'cash', collectedByEmployeeId: 'e1', shiftId: 'shift-1', createdAt: 4 },
      ]);
      repository.findShiftsByIds.mockResolvedValue([
        { id: 'shift-1', employeeId: 'e1', openingCashMinor: 0, closingCashMinor: null, expectedCashMinor: null, status: 'open', openedAt: 100, closedAt: null },
        { id: 'shift-2', employeeId: 'e2', openingCashMinor: 0, closingCashMinor: null, expectedCashMinor: null, status: 'open', openedAt: 200, closedAt: null },
      ]);

      const result = await service.getKpis({ range: 'custom', from: yesterday, to: yesterday });
      expect(result.revenueByShift).toEqual([
        { shiftId: 'shift-1', employeeId: 'e1', openedAt: 100, closedAt: null, revenueMinor: 70000 },
        { shiftId: 'shift-2', employeeId: 'e2', openedAt: 200, closedAt: null, revenueMinor: 40000 },
        { shiftId: null, employeeId: null, openedAt: null, closedAt: null, revenueMinor: 5000 },
      ]);
    });
  });

  describe('series endpoints (D2)', () => {
    it('single-day ranges produce 24 zero-filled hourly buckets', async () => {
      repository.findHourlyRollupRows.mockResolvedValue([{ date: yesterday, hour: 13, revenueMinor: 21000, ordersCount: 2 }]);
      const revenue = await service.getRevenueOverTime({ range: 'custom', from: yesterday, to: yesterday });
      expect(revenue.granularity).toBe('hour');
      expect(revenue.points).toHaveLength(24);
      expect(revenue.points[0]).toEqual({ bucket: '00', revenueMinor: 0 });
      expect(revenue.points[13]).toEqual({ bucket: '13', revenueMinor: 21000 });

      const orders = await service.getOrdersOverTime({ range: 'custom', from: yesterday, to: yesterday });
      expect(orders.points[13]).toEqual({ bucket: '13', ordersCount: 2 });
    });

    it('multi-day ranges produce a zero-filled daily continuum', async () => {
      repository.findDailyRollupRows.mockResolvedValue([
        { date: yesterday, totalRevenueMinor: 30000, dineInRevenueMinor: 30000, deliveryRevenueMinor: 0, totalOrders: 2, cancelledOrders: 0, updatedAt: 1 },
      ]);
      const revenue = await service.getRevenueOverTime({ range: 'custom', from: twoDaysAgo, to: yesterday });
      expect(revenue.granularity).toBe('day');
      expect(revenue.points).toEqual([
        { bucket: twoDaysAgo, revenueMinor: 0 },
        { bucket: yesterday, revenueMinor: 30000 },
      ]);
    });
  });

  describe('top products (D3)', () => {
    it('sorts by quantity, then net revenue, then name — capped at 10', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        date: yesterday,
        productNameSnapshot: `منتج ${String(i).padStart(2, '0')}`,
        categorySnapshot: 'أطباق',
        quantitySold: i === 0 ? 20 : 12 - i, // first row clearly on top
        revenueMinor: (12 - i) * 1000,
      }));
      repository.findProductRollupRows.mockResolvedValue(rows);

      const result = await service.getTopProducts({ range: 'custom', from: yesterday, to: yesterday });
      expect(result.products).toHaveLength(10);
      expect(result.products[0]).toMatchObject({ name: 'منتج 00', quantitySold: 20 });
      const quantities = result.products.map((p) => p.quantitySold);
      expect([...quantities].sort((a, b) => b - a)).toEqual(quantities);
    });
  });

  describe('operational stats (B3(a)/FR43)', () => {
    const staff = [
      { id: 'emp-k', name: 'Yanis', role: 'kitchen', email: null, passwordHash: null, pinHash: null, isActive: true, lastLoginAt: null, createdAt: 1, updatedAt: 1 },
      { id: 'emp-w', name: 'Sofia', role: 'waiter', email: null, passwordHash: null, pinHash: null, isActive: true, lastLoginAt: null, createdAt: 1, updatedAt: 1 },
    ];

    it('computes neutral per-employee metrics, sorted by name only', async () => {
      repository.findActiveKitchenWaiterStaff.mockResolvedValue(staff);
      repository.findActorEventsInWindow.mockResolvedValue([
        // waiter created the order (initial pending event) and served it
        eventRow({ orderId: 'o1', fromStatus: null, toStatus: 'pending', actorEmployeeId: 'emp-w', createdAt: dayStart(yesterday) + 1000 }),
        eventRow({ id: 'ev-2', orderId: 'o1', toStatus: 'served', actorEmployeeId: 'emp-w', createdAt: dayStart(yesterday) + 9000 }),
        // kitchen accepted and brought to ready
        eventRow({ id: 'ev-3', orderId: 'o1', toStatus: 'accepted', actorEmployeeId: 'emp-k', createdAt: dayStart(yesterday) + 3000 }),
        eventRow({ id: 'ev-4', orderId: 'o1', toStatus: 'ready', actorEmployeeId: 'emp-k', createdAt: dayStart(yesterday) + 603000 }),
      ]);
      repository.findOrdersByIds.mockResolvedValue([orderRow({ id: 'o1', createdAt: dayStart(yesterday) + 1000 })]);
      repository.findEventsByOrderIdsAndStatus.mockResolvedValue([
        eventRow({ id: 'ev-3', orderId: 'o1', toStatus: 'accepted', actorEmployeeId: 'emp-k', createdAt: dayStart(yesterday) + 3000 }),
      ]);

      const result = await service.getOperationalStats({ range: 'custom', from: yesterday, to: yesterday });

      expect(result.employees.map((e) => e.employeeName)).toEqual(['Sofia', 'Yanis']); // NAME order — never metric order
      const sofia = result.employees[0];
      expect(sofia).toMatchObject({ employeeId: 'emp-w', role: 'waiter', ordersHandled: 1, averageAcceptanceTimeMs: null, averagePreparationTimeMs: null });
      const yanis = result.employees[1];
      expect(yanis).toMatchObject({
        employeeId: 'emp-k',
        role: 'kitchen',
        ordersHandled: 1,
        averageAcceptanceTimeMs: 2000, // accepted 2s after creation
        averagePreparationTimeMs: 600_000, // ready 10min after accepted
      });
    });

    it('shows active staff with no activity as explicit nulls, and honors the employeeId filter', async () => {
      repository.findActiveKitchenWaiterStaff.mockResolvedValue(staff);
      repository.findActorEventsInWindow.mockResolvedValue([]);

      const all = await service.getOperationalStats({ range: 'custom', from: yesterday, to: yesterday });
      expect(all.employees).toHaveLength(2);
      expect(all.employees[0]).toMatchObject({ ordersHandled: 0, averageAcceptanceTimeMs: null, averagePreparationTimeMs: null });

      const filtered = await service.getOperationalStats({ range: 'custom', from: yesterday, to: yesterday, employeeId: 'emp-w' });
      expect(filtered.employees).toHaveLength(1);
      expect(filtered.employees[0].employeeId).toBe('emp-w');

      // a cashier id is outside the FR43 surface → empty
      const cashier = await service.getOperationalStats({ range: 'custom', from: yesterday, to: yesterday, employeeId: 'emp-cashier' });
      expect(cashier.employees).toEqual([]);
    });
  });
});
