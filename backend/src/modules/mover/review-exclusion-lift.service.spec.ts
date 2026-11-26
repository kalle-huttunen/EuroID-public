/**
 * Lifting an access review exclusion starts the run that gives the access back, with the admin
 * as actor: the identity's re-evaluation for an entitlement, onboarding for an account (the
 * re-evaluation creates no account; onboarding skips the SYNCED targets and creates the missing
 * one). When the run cannot start, the lift stays done and the answer says why; a lift the
 * exclusion refuses (404, 409) starts nothing.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { ReviewExclusionService } from '../policy/review-exclusion.service';
import type { AccessReevaluationService } from './access-reevaluation.service';
import {
  ACCOUNT_LIFT_ONBOARDING_REASON,
  ReviewExclusionLiftService,
} from './review-exclusion-lift.service';

const ID = '64b7f0c2a1b2c3d4e5f60a01';
const EXCLUSION = '64b7f0c2a1b2c3d4e5f60b01';
const ADMIN = 'policy.admin@acme.test';
const GROUP = {
  _id: EXCLUSION,
  identityId: ID,
  scope: 'entitlement',
  targetSystem: 'entra-id',
  status: 'lifted',
  liftedBy: ADMIN,
};
const ACCOUNT = { ...GROUP, scope: 'account', targetSystem: 'github' };

function setup(lifted: object = GROUP) {
  const exclusions = { lift: jest.fn().mockResolvedValue(lifted) };
  const reevaluation = {
    reevaluate: jest.fn().mockResolvedValue({ workflowId: 'wf-mover-1', changedFields: [] }),
  };
  const events = { emitAndWait: jest.fn().mockResolvedValue(['t-tenant-a-onboard-x']) };
  const service = new ReviewExclusionLiftService(
    exclusions as unknown as ReviewExclusionService,
    reevaluation as unknown as AccessReevaluationService,
    events as unknown as DomainEventEmitterService,
  );
  return { service, exclusions, reevaluation, events };
}

describe('ReviewExclusionLiftService', () => {
  describe('an entitlement exclusion', () => {
    it('lifts, then starts the re-evaluation as the admin', async () => {
      const { service, exclusions, reevaluation, events } = setup();

      await expect(service.lift(ID, EXCLUSION, ADMIN)).resolves.toEqual({
        exclusion: GROUP,
        run: { type: 'reevaluation', started: true, workflowId: 'wf-mover-1' },
      });
      expect(exclusions.lift).toHaveBeenCalledWith(ID, EXCLUSION, ADMIN);
      expect(reevaluation.reevaluate).toHaveBeenCalledWith(ID, ADMIN);
      expect(exclusions.lift.mock.invocationCallOrder[0]).toBeLessThan(
        reevaluation.reevaluate.mock.invocationCallOrder[0],
      );
      expect(events.emitAndWait).not.toHaveBeenCalled();
    });

    it('keeps the lift and says why when the re-evaluation refuses to start', async () => {
      const { service, reevaluation } = setup();
      reevaluation.reevaluate.mockRejectedValue(
        new ConflictException('A mover run for this identity is already in progress.'),
      );

      await expect(service.lift(ID, EXCLUSION, ADMIN)).resolves.toEqual({
        exclusion: GROUP,
        run: {
          type: 'reevaluation',
          started: false,
          reason: 'A mover run for this identity is already in progress.',
        },
      });
    });

    it('keeps the lift and asks for a re-evaluation when Temporal cannot be reached', async () => {
      const { service, reevaluation } = setup();
      reevaluation.reevaluate.mockRejectedValue(new Error('14 UNAVAILABLE: connect ECONNREFUSED'));

      const result = await service.lift(ID, EXCLUSION, ADMIN);

      expect(result.exclusion).toEqual(GROUP);
      expect(result.run).toEqual({
        type: 'reevaluation',
        started: false,
        reason: expect.stringContaining('Run Re-evaluate access'),
      });
      expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    });
  });

  describe('an account exclusion', () => {
    it('lifts, then starts onboarding as the admin, no re-evaluation', async () => {
      const { service, reevaluation, events } = setup(ACCOUNT);

      await expect(service.lift(ID, EXCLUSION, ADMIN)).resolves.toEqual({
        exclusion: ACCOUNT,
        run: { type: 'onboarding', started: true, workflowId: 't-tenant-a-onboard-x' },
      });
      expect(events.emitAndWait).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_PROVISION_REQUESTED,
        ID,
        { reason: ACCOUNT_LIFT_ONBOARDING_REASON },
        { actor: ADMIN },
      );
      expect(reevaluation.reevaluate).not.toHaveBeenCalled();
    });

    it('says an onboarding run is already in progress', async () => {
      const { service, events } = setup(ACCOUNT);
      events.emitAndWait.mockRejectedValue(
        new WorkflowExecutionAlreadyStartedError('started', 't-tenant-a-onboard-x', 'onboarding'),
      );

      const { run } = await service.lift(ID, EXCLUSION, ADMIN);

      expect(run).toEqual({
        type: 'onboarding',
        started: false,
        reason: expect.stringContaining('already in progress'),
      });
    });

    it('says why when the identity has no email (the handler starts nothing)', async () => {
      const { service, events } = setup(ACCOUNT);
      events.emitAndWait.mockResolvedValue([undefined]);

      const { run } = await service.lift(ID, EXCLUSION, ADMIN);

      expect(run).toEqual({
        type: 'onboarding',
        started: false,
        reason: expect.stringContaining('no email address'),
      });
    });

    it('asks to provision again when Temporal cannot be reached', async () => {
      const { service, events } = setup(ACCOUNT);
      events.emitAndWait.mockRejectedValue(new Error('14 UNAVAILABLE: connect ECONNREFUSED'));

      const result = await service.lift(ID, EXCLUSION, ADMIN);

      expect(result.run).toEqual({
        type: 'onboarding',
        started: false,
        reason: expect.stringContaining('Provision the identity again'),
      });
      expect(JSON.stringify(result)).not.toContain('ECONNREFUSED');
    });
  });

  it('starts nothing when the exclusion cannot be lifted', async () => {
    const { service, exclusions, reevaluation, events } = setup();
    exclusions.lift.mockRejectedValue(new NotFoundException('No review exclusion'));

    await expect(service.lift(ID, EXCLUSION, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(reevaluation.reevaluate).not.toHaveBeenCalled();
    expect(events.emitAndWait).not.toHaveBeenCalled();
  });
});
