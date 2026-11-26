/**
 * Orphan Cleanup Workflow Tests
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility.
 *
 * Signal testing strategy: We capture signal handlers registered via setHandler,
 * then invoke them between condition calls to simulate signal delivery.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};
const signalHandlers: Record<symbol, (...args: any[]) => void> = {};

// Signal symbols
const ADOPT_SIGNAL = Symbol('ADOPT_ACCOUNT');
const DELETE_SIGNAL = Symbol('DELETE_ACCOUNT');
const EXTEND_SIGNAL = Symbol('EXTEND_GRACE_PERIOD');

const mockCondition = jest.fn<Promise<boolean>, [() => boolean, string]>();
const mockPatched = jest.fn<boolean, [string]>();

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(
    () =>
      new Proxy(
        {},
        {
          get: (_target: unknown, prop: string) => {
            if (!stableRefs[prop]) {
              if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
              stableRefs[prop] = (...args: unknown[]) => mockActivities[prop](...args);
            }
            return stableRefs[prop];
          },
        },
      ),
  ),
  defineSignal: jest.fn((name: string) => {
    if (name === 'ADOPT_ACCOUNT') return ADOPT_SIGNAL;
    if (name === 'DELETE_ACCOUNT') return DELETE_SIGNAL;
    if (name === 'EXTEND_GRACE_PERIOD') return EXTEND_SIGNAL;
    return Symbol(name);
  }),
  setHandler: jest.fn((signal: symbol, handler: (...args: any[]) => void) => {
    signalHandlers[signal] = handler;
  }),
  sleep: jest.fn().mockResolvedValue(undefined),
  condition: mockCondition,
  patched: (id: string) => mockPatched(id),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { orphanCleanupWorkflow } from './orphan-cleanup.workflow';

describe('Orphan Cleanup Workflow', () => {
  const defaultInput = {
    driftId: 'drift-1',
    targetSystem: 'entra-id',
    externalId: 'ext-123',
    accountIdentifier: 'orphan@test.com',
    tenantId: 'test-tenant',
  };

  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    Object.getOwnPropertySymbols(signalHandlers).forEach((s) => delete signalHandlers[s]);
    mockCondition.mockReset();
    // A run started now; a history from before the patch replays with false
    mockPatched.mockReset().mockReturnValue(true);
    // The account is still an orphan when the cleanup acts, unless a test says otherwise
    mockActivities.confirmOrphan = jest.fn().mockResolvedValue({ orphan: true });
  });

  it('adopts orphan when signal received during first grace period', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 30,
      extendedGraceDays: 7,
      autoDeleteAfterExtended: true,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.adoptOrphanAccount = jest.fn().mockResolvedValue(undefined);

    // First condition call: simulate signal resolved (adopt signal received)
    mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
      // Trigger adopt signal before evaluating condition
      signalHandlers[ADOPT_SIGNAL]?.('identity-456');
      return fn();
    });

    await orphanCleanupWorkflow(defaultInput);

    // Detection emitted orphan.detected; the workflow does not again
    expect(mockActivities.emitOrphanDetected).not.toHaveBeenCalled();
    expect(mockActivities.adoptOrphanAccount).toHaveBeenCalledWith(
      'drift-1',
      'identity-456',
      'entra-id',
      'ext-123',
      'workflow-signal',
      'test-tenant',
    );
  });

  it('auto-deletes orphan when grace periods expire and autoDeleteAfterExtended is true', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 0,
      extendedGraceDays: 0,
      autoDeleteAfterExtended: true,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(undefined);
    mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
    mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);

    // Both condition calls return false (timeout expired, no signal)
    mockCondition.mockResolvedValueOnce(false); // first grace period expires
    mockCondition.mockResolvedValueOnce(false); // extended grace period expires

    await orphanCleanupWorkflow({
      ...defaultInput,
      driftId: 'drift-2',
      externalId: 'ext-456',
      accountIdentifier: 'orphan2@test.com',
    });

    // Detection emitted orphan.detected; the workflow does not again
    expect(mockActivities.emitOrphanDetected).not.toHaveBeenCalled();
    expect(mockActivities.disableOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      'orphan2@test.com',
      'test-tenant',
    );
    expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      'orphan2@test.com',
      'test-tenant',
      undefined,
      'ext-456',
    );
    expect(mockActivities.updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-2',
      'corrected',
      'DELETE',
      'auto-after-grace',
      'test-tenant',
    );
  });

  it('deletes immediately when deleteAccountSignal received during grace period', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 30,
      extendedGraceDays: 7,
      autoDeleteAfterExtended: true,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
    mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);

    // First condition: simulate delete signal during grace period
    mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
      signalHandlers[DELETE_SIGNAL]?.();
      return fn();
    });

    await orphanCleanupWorkflow({
      ...defaultInput,
      driftId: 'drift-3',
      externalId: 'ext-789',
      accountIdentifier: 'orphan3@test.com',
    });

    expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      'orphan3@test.com',
      'test-tenant',
      undefined,
      'ext-789',
    );
    expect(mockActivities.updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-3',
      'corrected',
      'DELETE',
      'workflow-signal',
      'test-tenant',
    );
  });

  it('extends grace period when extendGracePeriodSignal received', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 0,
      extendedGraceDays: 0,
      autoDeleteAfterExtended: true,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(undefined);
    mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);
    mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
    mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);

    // First condition: times out (no signal during first grace)
    mockCondition.mockResolvedValueOnce(false);
    // Second condition: simulate extend + delete signals
    mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
      signalHandlers[EXTEND_SIGNAL]?.(14);
      signalHandlers[DELETE_SIGNAL]?.();
      return fn();
    });

    await orphanCleanupWorkflow({
      ...defaultInput,
      driftId: 'drift-4',
      externalId: 'ext-101',
      accountIdentifier: 'orphan4@test.com',
    });

    // The signal was received (workflow didn't crash)
    expect(mockActivities.deleteOrphanAccount).toHaveBeenCalled();
  });

  it('keeps account disabled when autoDeleteAfterExtended is false and no signal', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 0,
      extendedGraceDays: 0,
      autoDeleteAfterExtended: false,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(undefined);
    mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);

    // Both conditions time out
    mockCondition.mockResolvedValueOnce(false);
    mockCondition.mockResolvedValueOnce(false);

    await orphanCleanupWorkflow(defaultInput);

    expect(mockActivities.disableOrphanAccount).toHaveBeenCalled();
    expect(mockActivities.deleteOrphanAccount).toBeUndefined();
  });

  // orphan.detected was emitted twice per orphan: by detection and again here
  it('emits orphan.detected only when replaying a history from before detection emitted it', async () => {
    mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
      gracePeriodDays: 0,
      extendedGraceDays: 0,
      autoDeleteAfterExtended: false,
    });
    mockActivities.emitOrphanDetected = jest.fn().mockResolvedValue(undefined);
    mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(undefined);
    mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);
    mockCondition.mockResolvedValue(false);

    await orphanCleanupWorkflow(defaultInput);
    expect(mockPatched).toHaveBeenCalledWith('orphan-cleanup:detection-emits-orphan-detected');
    expect(mockActivities.emitOrphanDetected).not.toHaveBeenCalled();

    mockPatched.mockReturnValue(false);
    await orphanCleanupWorkflow(defaultInput);
    expect(mockActivities.emitOrphanDetected).toHaveBeenCalledTimes(1);
    expect(mockActivities.emitOrphanDetected).toHaveBeenCalledWith(
      'drift-1',
      'entra-id',
      'ext-123',
      'orphan@test.com',
      'test-tenant',
    );
  });

  /**
   * Before it disables or deletes, the cleanup asks again (patch orphan-cleanup:recheck-before-
   * acting): IT may have pre-created the account and HR the identity on day 20 of the grace
   * (hunt r2-05 N4). A disable that changed nothing no longer stamps disabledAt (05 F9).
   */
  describe('acting only on an account that is still an orphan', () => {
    const graceOver = () => {
      mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
        gracePeriodDays: 30,
        extendedGraceDays: 30,
        autoDeleteAfterExtended: true,
      });
      mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(true);
      mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
      mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);
    };

    it('leaves an account an identity has now as it is, and ends', async () => {
      graceOver();
      mockActivities.confirmOrphan = jest
        .fn()
        .mockResolvedValue({ orphan: false, reason: 'the account is no longer an orphan' });
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow(defaultInput);

      expect(mockPatched).toHaveBeenCalledWith('orphan-cleanup:recheck-before-acting');
      expect(mockActivities.confirmOrphan).toHaveBeenCalledWith(
        'drift-1',
        'orphan@test.com',
        'test-tenant',
      );
      expect(mockActivities.disableOrphanAccount).not.toHaveBeenCalled();
      expect(mockActivities.deleteOrphanAccount).not.toHaveBeenCalled();
    });

    it('asks again before the auto-delete after the extended grace', async () => {
      graceOver();
      mockActivities.confirmOrphan = jest
        .fn()
        .mockResolvedValueOnce({ orphan: true })
        .mockResolvedValueOnce({ orphan: false, reason: 'its drift is ignored' });
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow(defaultInput);

      expect(mockActivities.disableOrphanAccount).toHaveBeenCalled();
      expect(mockActivities.deleteOrphanAccount).not.toHaveBeenCalled();
    });

    it('does not delete on a DELETE signal when the account has an owner now', async () => {
      graceOver();
      mockActivities.confirmOrphan = jest.fn().mockResolvedValue({ orphan: false, reason: 'x' });
      mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
        signalHandlers[DELETE_SIGNAL]?.('ops@corp.example');
        return fn();
      });

      await orphanCleanupWorkflow(defaultInput);

      expect(mockActivities.deleteOrphanAccount).not.toHaveBeenCalled();
    });

    it('leaves disabledAt unset when the disable changed nothing', async () => {
      graceOver();
      mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(false);
      mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
        gracePeriodDays: 30,
        extendedGraceDays: 30,
        autoDeleteAfterExtended: false,
      });
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow({ ...defaultInput, targetSystem: 'ad' });

      expect(mockActivities.disableOrphanAccount).toHaveBeenCalledWith(
        'ad',
        'orphan@test.com',
        'test-tenant',
      );
      expect(mockActivities.setOrphanDisabledAt).not.toHaveBeenCalled();
    });

    it('does not record a deleted account when the delete failed', async () => {
      graceOver();
      mockActivities.deleteOrphanAccount = jest
        .fn()
        .mockResolvedValue({ success: false, error: 'Unknown system: ad' });
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow({ ...defaultInput, targetSystem: 'ad' });

      expect(mockActivities.updateOrphanDriftStatus).not.toHaveBeenCalled();
    });

    it('in a history from before the patch, acts without asking and stamps disabledAt', async () => {
      graceOver();
      mockPatched.mockImplementation((id: string) => id !== 'orphan-cleanup:recheck-before-acting');
      mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(false);
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow(defaultInput);

      expect(mockActivities.confirmOrphan).not.toHaveBeenCalled();
      expect(mockActivities.setOrphanDisabledAt).toHaveBeenCalledWith('drift-1', 'test-tenant');
      expect(mockActivities.deleteOrphanAccount).toHaveBeenCalled();
    });
  });

  /** ADOPT and DELETE decisions recorded 'workflow-signal', so who decided was lost (05 F17). */
  describe('who decided a signalled ADOPT or DELETE', () => {
    beforeEach(() => {
      mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
        gracePeriodDays: 30,
        extendedGraceDays: 30,
        autoDeleteAfterExtended: false,
      });
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
      mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);
      mockActivities.adoptOrphanAccount = jest.fn().mockResolvedValue(true);
    });

    it('records the operator the DELETE signal names', async () => {
      mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
        signalHandlers[DELETE_SIGNAL]?.('ops@corp.example');
        return fn();
      });

      await orphanCleanupWorkflow(defaultInput);

      expect(mockPatched).toHaveBeenCalledWith('orphan-cleanup:signal-actor');
      expect(mockActivities.updateOrphanDriftStatus).toHaveBeenCalledWith(
        'drift-1',
        'corrected',
        'DELETE',
        'ops@corp.example',
        'test-tenant',
      );
    });

    it('records the operator the ADOPT signal names', async () => {
      mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
        signalHandlers[ADOPT_SIGNAL]?.('identity-456', 'ops@corp.example');
        return fn();
      });

      await orphanCleanupWorkflow(defaultInput);

      expect(mockActivities.adoptOrphanAccount).toHaveBeenCalledWith(
        'drift-1',
        'identity-456',
        'entra-id',
        'ext-123',
        'ops@corp.example',
        'test-tenant',
      );
    });

    it('records workflow-signal for a signal without one, or before the patch', async () => {
      mockPatched.mockImplementation((id: string) => id !== 'orphan-cleanup:signal-actor');
      mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
        signalHandlers[DELETE_SIGNAL]?.('ops@corp.example');
        return fn();
      });

      await orphanCleanupWorkflow(defaultInput);

      expect(mockActivities.updateOrphanDriftStatus).toHaveBeenCalledWith(
        'drift-1',
        'corrected',
        'DELETE',
        'workflow-signal',
        'test-tenant',
      );
    });
  });

  /** EuroID never deletes an AD account (HX-F report follow-up, owner decision). */
  describe('an Active Directory orphan', () => {
    const adInput = { ...defaultInput, targetSystem: 'ad' };
    const graceOver = () => {
      mockActivities.getOrphanConfig = jest.fn().mockResolvedValue({
        gracePeriodDays: 30,
        extendedGraceDays: 30,
        autoDeleteAfterExtended: true,
      });
      mockActivities.disableOrphanAccount = jest.fn().mockResolvedValue(true);
      mockActivities.setOrphanDisabledAt = jest.fn().mockResolvedValue(undefined);
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: false });
      mockActivities.updateOrphanDriftStatus = jest.fn().mockResolvedValue(undefined);
      mockActivities.keepOrphanAccount = jest.fn().mockResolvedValue(undefined);
    };

    it('stays disabled after the extended grace, the reason recorded, never deleted', async () => {
      graceOver();
      mockCondition.mockResolvedValue(false);

      await orphanCleanupWorkflow(adInput);

      expect(mockPatched).toHaveBeenCalledWith('orphan-cleanup:ad-never-deleted');
      expect(mockActivities.disableOrphanAccount).toHaveBeenCalled();
      expect(mockActivities.deleteOrphanAccount).not.toHaveBeenCalled();
      expect(mockActivities.keepOrphanAccount).toHaveBeenCalledWith(
        'drift-1',
        expect.stringContaining('never deletes an Active Directory account'),
        'test-tenant',
      );
    });

    it('is not deleted on a DELETE signal either', async () => {
      graceOver();
      mockCondition.mockImplementationOnce(async () => {
        signalHandlers[DELETE_SIGNAL]('ops@corp.example');
        return true;
      });

      await orphanCleanupWorkflow(adInput);

      expect(mockActivities.deleteOrphanAccount).not.toHaveBeenCalled();
      expect(mockActivities.keepOrphanAccount).toHaveBeenCalled();
    });

    it('in a history from before the patch, tries the delete as before', async () => {
      graceOver();
      mockCondition.mockResolvedValue(false);
      mockPatched.mockImplementation((id) => id !== 'orphan-cleanup:ad-never-deleted');

      await orphanCleanupWorkflow(adInput);

      expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
        'ad',
        'orphan@test.com',
        'test-tenant',
        undefined,
        'ext-123',
      );
      expect(mockActivities.keepOrphanAccount).not.toHaveBeenCalled();
    });

    // HX-F2 follow-up: the delete got the account identifier only, so a SCIM orphan was found by
    // userName or email and never by the SCIM id its drift holds (externalId)
    it('passes the drift external id to the delete (orphan-cleanup:delete-by-external-id)', async () => {
      graceOver();
      mockCondition.mockResolvedValue(false);
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });

      await orphanCleanupWorkflow({ ...defaultInput, targetSystem: 'scim' });

      expect(mockPatched).toHaveBeenCalledWith('orphan-cleanup:delete-by-external-id');
      expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
        'scim',
        'orphan@test.com',
        'test-tenant',
        undefined,
        'ext-123',
      );
    });

    it('in a history from before that patch, deletes by the identifier only', async () => {
      graceOver();
      mockCondition.mockResolvedValue(false);
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });
      mockPatched.mockImplementation((id) => id !== 'orphan-cleanup:delete-by-external-id');

      await orphanCleanupWorkflow({ ...defaultInput, targetSystem: 'scim' });

      expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
        'scim',
        'orphan@test.com',
        'test-tenant',
      );
    });

    it('asks about no AD patch for another system', async () => {
      graceOver();
      mockCondition.mockResolvedValue(false);
      mockActivities.deleteOrphanAccount = jest.fn().mockResolvedValue({ success: true });

      await orphanCleanupWorkflow({ ...defaultInput, targetSystem: 'scim' });

      expect(mockPatched).not.toHaveBeenCalledWith('orphan-cleanup:ad-never-deleted');
      expect(mockActivities.deleteOrphanAccount).toHaveBeenCalledWith(
        'scim',
        'orphan@test.com',
        'test-tenant',
        undefined,
        'ext-123',
      );
    });
  });
});
