import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axiosInstance } from '@api/data';
import {
  fetchDrifts,
  fetchDriftsPaginated,
  fetchOpenDriftCounts,
  fetchOrphans,
} from '@api/reconciliation-api';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);

// A drift as GET /reconciliation/drifts sends it: a lean MongoDB document, so `_id` and no `id`.
const apiDrift = {
  _id: '6650a1b2c3d4e5f6a7b8c9d0',
  tenantId: 'dev-tenant',
  type: 'FIELD_MISMATCH',
  severity: 'medium',
  userId: '6650aaaaaaaaaaaaaaaaaaaa',
  userDisplayName: 'Matti Virtanen',
  userEmail: 'm•••@example.com',
  targetSystem: 'entra-id',
  field: 'jobTitle',
  hubValue: 'Senior Developer',
  targetValue: 'Developer',
  detectedAt: '2026-11-22T10:00:00.000Z',
  autoCorrectEligible: true,
  status: 'open',
  createdAt: '2026-11-22T10:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  __v: 0,
};

const page = (drifts: unknown[]) => ({
  data: { success: true, drifts, total: drifts.length, page: 1, limit: 50, totalPages: 1 },
});

// Correct, ignore, bulk actions and row keys all use the drift's id: without it the UI sent
// POST /reconciliation/drifts/undefined/correct.
describe('reconciliation API drift ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockReset();
  });

  it("fetchDrifts gives each drift the API's _id as its id", async () => {
    get.mockResolvedValue(page([apiDrift]));

    const drifts = await fetchDrifts();

    expect(drifts).toHaveLength(1);
    expect(drifts[0].id).toBe('6650a1b2c3d4e5f6a7b8c9d0');
    expect(drifts[0].field).toBe('jobTitle');
  });

  // 2.0dt: the identity's drifts were picked here from the tenant's 50 most recent drifts of any
  // status, so older ones never showed and corrected ones stayed. The API filters them now.
  it("fetchDrifts for one identity asks the API for that identity's open drifts", async () => {
    get.mockResolvedValue(page([apiDrift]));

    const drifts = await fetchDrifts({ identityId: '6650aaaaaaaaaaaaaaaaaaaa' });

    expect(get).toHaveBeenCalledTimes(1);
    const query = new URLSearchParams(String(get.mock.calls[0][0]).split('?')[1]);
    expect(query.get('userId')).toBe('6650aaaaaaaaaaaaaaaaaaaa');
    expect(query.get('status')).toBe('open');
    expect(query.get('limit')).toBe('100');
    expect(query.has('identityId')).toBe(false);
    expect(drifts.map((d) => d.id)).toEqual(['6650a1b2c3d4e5f6a7b8c9d0']);
  });

  it("fetchDrifts for one identity reads every page of the identity's drifts", async () => {
    const second = { ...apiDrift, _id: '6650a1b2c3d4e5f6a7b8c9d1' };
    get
      .mockResolvedValueOnce({
        data: { success: true, drifts: [apiDrift], total: 101, page: 1, limit: 100, totalPages: 2 },
      })
      .mockResolvedValueOnce({
        data: { success: true, drifts: [second], total: 101, page: 2, limit: 100, totalPages: 2 },
      });

    const drifts = await fetchDrifts({ identityId: '6650aaaaaaaaaaaaaaaaaaaa' });

    expect(
      get.mock.calls.map(([url]) => new URL(String(url), 'http://x').searchParams.get('page')),
    ).toEqual(['1', '2']);
    expect(drifts.map((d) => d.id)).toEqual([
      '6650a1b2c3d4e5f6a7b8c9d0',
      '6650a1b2c3d4e5f6a7b8c9d1',
    ]);
  });

  it("fetchDriftsPaginated gives each drift the API's _id as its id", async () => {
    get.mockResolvedValue(page([apiDrift]));

    const result = await fetchDriftsPaginated({ page: 1, limit: 50 });

    expect(result.drifts.map((d) => d.id)).toEqual(['6650a1b2c3d4e5f6a7b8c9d0']);
  });

  it("fetchOrphans gives each orphan drift the API's _id as its id", async () => {
    get.mockResolvedValue(
      page([{ ...apiDrift, type: 'ORPHAN_ACCOUNT', workflowId: 'orphan-cleanup-1' }]),
    );

    const result = await fetchOrphans();

    expect(result.drifts.map((d) => d.id)).toEqual(['6650a1b2c3d4e5f6a7b8c9d0']);
  });
});

// The identity hub's drift column: open drifts of the identities on the page, one request (per
// 100 identities, the most the API takes), instead of the tenant's 50 most recent drifts.
describe('fetchOpenDriftCounts', () => {
  beforeEach(() => {
    get.mockReset();
  });

  const idsOf = (call: unknown[]) =>
    new URL(String(call[0]), 'http://x').searchParams.get('userIds')?.split(',');

  it("asks for the identities' open drift counts in one request", async () => {
    get.mockResolvedValue({ data: { success: true, counts: { 'id-2': 3 } } });

    const counts = await fetchOpenDriftCounts(['id-1', 'id-2', 'id-3']);

    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0][0])).toContain('/reconciliation/drifts/open-counts?');
    expect(idsOf(get.mock.calls[0])).toEqual(['id-1', 'id-2', 'id-3']);
    expect(counts).toEqual({ 'id-2': 3 });
  });

  it('asks in requests of at most 100 identities', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    get
      .mockResolvedValueOnce({ data: { success: true, counts: { 'id-0': 1 } } })
      .mockResolvedValueOnce({ data: { success: true, counts: { 'id-120': 2 } } });

    const counts = await fetchOpenDriftCounts(ids);

    expect(get.mock.calls.map((call) => idsOf(call)?.length)).toEqual([100, 50]);
    expect(counts).toEqual({ 'id-0': 1, 'id-120': 2 });
  });

  it('asks nothing for no identities', async () => {
    await expect(fetchOpenDriftCounts([])).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });
});
