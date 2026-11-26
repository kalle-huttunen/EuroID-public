/**
 * entitlementExpiryWorkflow's batches, with mocked Temporal APIs. With the patch
 * entitlement-expiry:continue-past-failures a batch whose entries all failed does not end the run;
 * histories from before it (patched() false) end at the first batch that deprovisions nothing.
 * The replay of a real pre-patch history is in test/workflows/entitlement-expiry.workflow.e2e-spec.ts.
 */
const mockRun = jest.fn();
const mockPatched = jest.fn<boolean, [string]>();

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(() => ({
    runEntitlementExpiryCheck: (...args: unknown[]) => mockRun(...args),
  })),
  patched: (id: string) => mockPatched(id),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { entitlementExpiryWorkflow } from './entitlement-expiry.workflow';

const batch = (over: Record<string, number> = {}) => ({
  processed: 0,
  failed: 0,
  expiringSoonCount: 0,
  expiringTomorrowCount: 0,
  ...over,
});

function answer(batches: Array<Record<string, number>>) {
  for (const b of batches) mockRun.mockResolvedValueOnce(batch(b));
  mockRun.mockResolvedValue(batch());
}

beforeEach(() => {
  mockRun.mockReset();
  mockPatched.mockReset().mockReturnValue(true);
});

describe('entitlementExpiryWorkflow', () => {
  it('does not ask for the patch while batches deprovision or have nothing to do', async () => {
    answer([
      { processed: 5, expiringSoonCount: 1 },
      { processed: 1, expiringTomorrowCount: 2 },
    ]);

    await expect(entitlementExpiryWorkflow({ tenantId: 'tenant-a' })).resolves.toEqual({
      processed: 6,
      failed: 0,
      expiringSoonCount: 1,
      expiringTomorrowCount: 2,
    });
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(mockRun.mock.calls[0][0]).toBe('tenant-a');
    expect(mockRun.mock.calls[0][2]).toBe(50);
    expect(mockPatched).not.toHaveBeenCalled();
  });

  it('a history from before the patch ends at the first batch that deprovisions nothing', async () => {
    mockPatched.mockReturnValue(false);
    answer([{ processed: 1 }, { failed: 2 }, { processed: 4 }]);

    await expect(entitlementExpiryWorkflow()).resolves.toMatchObject({ processed: 1, failed: 2 });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('a batch result without `failed` (pre-patch activity) ends the run as before', async () => {
    mockRun
      .mockResolvedValueOnce({ processed: 1, expiringSoonCount: 0, expiringTomorrowCount: 0 })
      .mockResolvedValue({ processed: 0, expiringSoonCount: 0, expiringTomorrowCount: 0 });

    await expect(entitlementExpiryWorkflow()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockPatched).not.toHaveBeenCalled();
  });
});
