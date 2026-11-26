/**
 * The drift routes of ReconciliationController.
 *
 * GET /reconciliation/drifts takes `userId`: the identity page lists that identity's open drifts
 * from the API. Without it the page picked them in the browser from the tenant's 50 most recent
 * drifts of any status, so older drifts never showed and corrected ones stayed listed (2.0dt).
 *
 * POST /reconciliation/drifts/bulk-correct says how many drifts it corrected and why each other
 * one was not. It answered `{ success: true, corrected: 0 }` when every correction failed (2.0dt).
 */

import { ZodError } from 'zod';
import { HttpException } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import type { DriftService } from './drift.service';
import type { OrphanCleanupService } from './orphan-cleanup.service';

function setup() {
  const driftService = {
    getDrifts: jest
      .fn()
      .mockResolvedValue({ drifts: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
    bulkAutoCorrect: jest.fn(),
    countOpenByUser: jest.fn().mockResolvedValue({ [IDENTITY_ID]: 2 }),
  };
  const controller = new ReconciliationController(
    {} as never,
    driftService as unknown as DriftService,
    {} as never,
    {} as never,
  );
  return { controller, driftService };
}

const IDENTITY_ID = '6650aaaaaaaaaaaaaaaaaaaa';

describe('GET /reconciliation/drifts', () => {
  it("filters by the identity's _id and status", async () => {
    const { controller, driftService } = setup();

    await controller.getDrifts(
      undefined,
      undefined,
      undefined,
      'open',
      undefined,
      undefined,
      '100',
      IDENTITY_ID,
    );

    expect(driftService.getDrifts).toHaveBeenCalledWith(
      { userId: IDENTITY_ID, status: 'open' },
      1,
      100,
    );
  });

  it('lists every identity when no userId is given', async () => {
    const { controller, driftService } = setup();

    await controller.getDrifts();

    expect(driftService.getDrifts).toHaveBeenCalledWith({}, 1, 50);
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(201)],
  ])('rejects a userId that is %s (400 through ZodErrorFilter)', async (_label, userId) => {
    const { controller, driftService } = setup();

    await expect(
      controller.getDrifts(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        userId,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(driftService.getDrifts).not.toHaveBeenCalled();
  });
});

// The identity hub's drift column: open drifts of the identities on the page, one request.
// It read the tenant's 50 most recent drifts of any status instead.
describe('GET /reconciliation/drifts/open-counts', () => {
  it('counts the open drifts of the identities asked, each once', async () => {
    const { controller, driftService } = setup();
    const other = '6650bbbbbbbbbbbbbbbbbbbb';

    const answer = await controller.getOpenDriftCounts(`${IDENTITY_ID}, ${other},${IDENTITY_ID}`);

    expect(driftService.countOpenByUser).toHaveBeenCalledWith([IDENTITY_ID, other]);
    expect(answer).toEqual({ success: true, counts: { [IDENTITY_ID]: 2 } });
  });

  it.each([
    ['missing', undefined],
    ['empty', ' , '],
    ['more than 100 identities', Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',')],
    ['an id that is too long', 'x'.repeat(201)],
  ])('rejects userIds that are %s (400 through ZodErrorFilter)', async (_label, userIds) => {
    const { controller, driftService } = setup();

    await expect(controller.getOpenDriftCounts(userIds)).rejects.toBeInstanceOf(ZodError);
    expect(driftService.countOpenByUser).not.toHaveBeenCalled();
  });
});

describe('POST /reconciliation/drifts/bulk-correct', () => {
  it('is not a success when no drift could be corrected, and says why for each', async () => {
    const { controller, driftService } = setup();
    driftService.bulkAutoCorrect.mockResolvedValue({
      corrected: 0,
      failed: [
        { driftId: 'd1', error: 'The user was not found in entra-id' },
        { driftId: 'd2', error: 'Drift d2 not found' },
      ],
    });

    const answer = await controller.bulkCorrect({ driftIds: ['d1', 'd2'] });

    expect(answer).toEqual({
      success: false,
      corrected: 0,
      failed: 2,
      failures: [
        { driftId: 'd1', error: 'The user was not found in entra-id' },
        { driftId: 'd2', error: 'Drift d2 not found' },
      ],
    });
  });

  it('is a success when some drifts were corrected, with the others listed', async () => {
    const { controller, driftService } = setup();
    driftService.bulkAutoCorrect.mockResolvedValue({
      corrected: 1,
      failed: [{ driftId: 'd2', error: 'Unsupported drift type: GROUP_MISMATCH' }],
    });

    const answer = await controller.bulkCorrect({ driftIds: ['d1', 'd2'] });

    expect(answer).toEqual({
      success: true,
      corrected: 1,
      failed: 1,
      failures: [{ driftId: 'd2', error: 'Unsupported drift type: GROUP_MISMATCH' }],
    });
  });

  it('is a success with nothing failed when every drift was corrected', async () => {
    const { controller, driftService } = setup();
    driftService.bulkAutoCorrect.mockResolvedValue({ corrected: 2, failed: [] });

    const answer = await controller.bulkCorrect({ driftIds: ['d1', 'd2'] });

    expect(answer).toEqual({ success: true, corrected: 2, failed: 0, failures: [] });
  });
});

// Before: 400 "Orphan workflow not yet started" without a cleanup id, 500 when the cleanup had ended
describe('POST /reconciliation/orphans/:driftId/signal', () => {
  const DRIFT_ID = '6650bbbbbbbbbbbbbbbbbbbb';

  function signalSetup(drift: Record<string, unknown> | null, cleanupId: string) {
    const driftService = {
      getDriftById: jest.fn().mockResolvedValue(drift),
      updateDriftWorkflowId: jest.fn().mockResolvedValue(drift),
    };
    const orphanCleanup = { signal: jest.fn().mockResolvedValue(cleanupId) };
    const controller = new ReconciliationController(
      {} as never,
      driftService as unknown as DriftService,
      orphanCleanup as Partial<OrphanCleanupService> as never,
      {} as never,
    );
    return { controller, driftService, orphanCleanup };
  }

  const orphan = (workflowId?: string) => ({
    _id: DRIFT_ID,
    type: 'ORPHAN_ACCOUNT',
    status: 'quarantined',
    workflowId,
  });

  it('records the id of the cleanup run it started for a drift without a running one', async () => {
    const fresh = `t-tenant-a-orphan-cleanup-${DRIFT_ID}`;
    const { controller, driftService, orphanCleanup } = signalSetup(orphan(), fresh);

    const answer = await controller.signalOrphan(DRIFT_ID, { action: 'DELETE' }, {
      sub: 'user-1',
      email: 'ops@corp.example',
    } as never);

    expect(answer).toEqual({ success: true, message: 'Signal DELETE sent' });
    expect(orphanCleanup.signal).toHaveBeenCalledWith(
      orphan(),
      'DELETE',
      undefined,
      'ops@corp.example',
    );
    expect(driftService.updateDriftWorkflowId).toHaveBeenCalledWith(DRIFT_ID, fresh);
  });

  it('keeps the recorded id when the running cleanup got the signal', async () => {
    const { controller, driftService, orphanCleanup } = signalSetup(
      orphan('cleanup-1'),
      'cleanup-1',
    );

    const answer = await controller.signalOrphan(DRIFT_ID, {
      action: 'ADOPT',
      identityId: 'identity-1',
    });

    expect(answer).toEqual({ success: true, message: 'Signal ADOPT sent' });
    expect(orphanCleanup.signal).toHaveBeenCalledWith(
      orphan('cleanup-1'),
      'ADOPT',
      'identity-1',
      undefined,
    );
    expect(driftService.updateDriftWorkflowId).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown drift', null, { action: 'DELETE' }, 404],
    [
      'a drift that is no orphan',
      { _id: DRIFT_ID, type: 'FIELD_MISMATCH' },
      { action: 'DELETE' },
      404,
    ],
    ['ADOPT without an identity', orphan('cleanup-1'), { action: 'ADOPT' }, 400],
  ])('refuses %s and signals nothing', async (_label, drift, body, status) => {
    const { controller, orphanCleanup } = signalSetup(drift, 'cleanup-1');

    const answer = controller.signalOrphan(DRIFT_ID, body);

    await expect(answer).rejects.toBeInstanceOf(HttpException);
    await expect(answer).rejects.toMatchObject({ status });
    expect(orphanCleanup.signal).not.toHaveBeenCalled();
  });

  // EuroID never deletes an AD account (HX-F report follow-up, owner decision)
  it('refuses DELETE of an AD orphan with 422 saying why, and signals nothing', async () => {
    const adOrphan = { ...orphan('cleanup-1'), targetSystem: 'ad' };
    const { controller, orphanCleanup } = signalSetup(adOrphan, 'cleanup-1');

    const answer = controller.signalOrphan(DRIFT_ID, { action: 'DELETE' });

    await expect(answer).rejects.toMatchObject({ status: 422 });
    await expect(answer).rejects.toThrow(/never deletes an Active Directory account/);
    expect(orphanCleanup.signal).not.toHaveBeenCalled();
  });

  it('still adopts an AD orphan', async () => {
    const adOrphan = { ...orphan('cleanup-1'), targetSystem: 'ad' };
    const { controller, orphanCleanup } = signalSetup(adOrphan, 'cleanup-1');

    await controller.signalOrphan(DRIFT_ID, { action: 'ADOPT', identityId: 'identity-1' });

    expect(orphanCleanup.signal).toHaveBeenCalledWith(adOrphan, 'ADOPT', 'identity-1', undefined);
  });
});

describe('GET /reconciliation/orphans/:driftId/simulate-delete', () => {
  const DRIFT_ID = '6650cccccccccccccccccccc';
  const controllerFor = (targetSystem: string) =>
    new ReconciliationController(
      {} as never,
      {
        getDriftById: jest.fn().mockResolvedValue({
          _id: DRIFT_ID,
          type: 'ORPHAN_ACCOUNT',
          targetSystem,
          userEmail: 'old@corp.example',
          userDisplayName: 'Old Account',
        }),
      } as unknown as DriftService,
      {} as never,
      {} as never,
    );

  it('says an AD orphan would not be deleted', async () => {
    const answer = await controllerFor('ad').simulateOrphanDelete(DRIFT_ID);

    expect(answer).toMatchObject({ deletable: false });
    expect(answer.impact).toMatch(/never deletes an Active Directory account/);
  });

  it('describes the delete of a SCIM orphan', async () => {
    const answer = await controllerFor('scim').simulateOrphanDelete(DRIFT_ID);

    expect(answer).toMatchObject({ deletable: true });
    expect(answer.impact).toMatch(/permanently removed from scim/);
  });
});
