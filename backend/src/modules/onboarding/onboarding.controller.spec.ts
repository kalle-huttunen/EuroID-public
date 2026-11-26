/**
 * POST /onboarding/start ([Provision] on the Users page) names the person by email. The run's
 * workflow id is built from the identity's id (plan 2.0dn), so the controller reads the identity
 * first; an email no identity of the tenant has is a 404 the caller can act on, where before a
 * run started and failed in Temporal (UserNotFound).
 */
import { NotFoundException } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import type { OnboardingService } from './onboarding.service';
import type { IdentityService } from '../identity/identity.service';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const EMAIL = 'ada@corp.example';

describe('OnboardingController.startWorkflow', () => {
  const triggerOnboarding = jest.fn();
  const findIdentityByEmail = jest.fn();
  const controller = new OnboardingController(
    { triggerOnboarding } as unknown as OnboardingService,
    { findIdentityByEmail } as unknown as IdentityService,
  );

  beforeEach(() => {
    triggerOnboarding.mockReset().mockResolvedValue(`t-tenant-a-onboard-${ID}`);
    findIdentityByEmail.mockReset();
  });

  it("starts the run for the identity with this email and answers the run's id", async () => {
    findIdentityByEmail.mockResolvedValue({ _id: ID, profile: { email: EMAIL } });

    const res = await controller.startWorkflow({ email: EMAIL });

    expect(findIdentityByEmail).toHaveBeenCalledWith(EMAIL);
    expect(triggerOnboarding).toHaveBeenCalledWith({ identityId: ID, email: EMAIL });
    expect(res).toEqual(
      expect.objectContaining({
        workflowId: `t-tenant-a-onboard-${ID}`,
        trackingUrl: expect.stringContaining(`t-tenant-a-onboard-${ID}`),
      }),
    );
  });

  it('answers 404 with what to do for an email no identity has, and starts nothing', async () => {
    findIdentityByEmail.mockResolvedValue(null);

    const started = controller.startWorkflow({ email: EMAIL });

    await expect(started).rejects.toBeInstanceOf(NotFoundException);
    await expect(started).rejects.toThrow(/Create the identity or run an HR sync first/);
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });
});
