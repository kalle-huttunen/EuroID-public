/**
 * GET /analytics/upcoming-offboardings?refresh=true let any viewer force the full recompute (a
 * policy evaluation per leaver), which POST /analytics/refresh keeps to super-admins (hunt 05
 * F8). The refresh is honoured for a super-admin only; for others the list is still current
 * (computed on read).
 */
import { AnalyticsController } from './analytics.controller';
import type { AuthUser } from '@infrastructure/auth/auth-user.decorator';

describe('GET /analytics/upcoming-offboardings refresh', () => {
  const getUpcomingOffboardings = jest.fn().mockResolvedValue([]);
  const controller = new AnalyticsController(
    { getUpcomingOffboardings } as never,
    {} as never,
    {} as never,
  );
  const user = (roles: string[]) => ({ sub: 'u-1', roles }) as unknown as AuthUser;

  beforeEach(() => getUpcomingOffboardings.mockClear());

  it.each([
    [['super-admin'], true],
    [['viewer'], false],
    [['policy-admin', 'operator'], false],
  ])('roles %j: refresh %s', async (roles, refresh) => {
    await controller.getUpcomingOffboardings({ refresh: 'true' }, user(roles));

    expect(getUpcomingOffboardings).toHaveBeenCalledWith(30, refresh);
  });
});
