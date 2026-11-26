/**
 * The linked admin identity the admin-account-provisioning workflow provisions: its profile goes
 * to the connectors with the admin identity's id, so their provisioning events go under that id
 * and reach its timeline (2.8a: an event without an identity id has none, never an email key).
 */
import { PrivilegedAccessActivities } from './privileged-access.activities';
import type { PrivilegedAccessService } from '../modules/privileged-access/privileged-access.service';
import type { PamSessionStateService } from '../modules/privileged-access/pam-session-state.service';
import type { PamSessionService } from '../modules/privileged-access/pam-session.service';

describe('PrivilegedAccessActivities.getOrCreateLinkedAdminIdentity', () => {
  it('returns the admin profile with the admin identity id as _id', async () => {
    const profile = { email: 'adm-ada@corp.example', firstName: 'Ada', lastName: 'Admin' };
    const adminIdentity = {
      _id: { toString: () => 'admin-1' },
      profile,
      toObject: () => ({ _id: { toString: () => 'admin-1' }, profile: { ...profile } }),
    };
    const service = {
      createLinkedAdminIdentity: jest.fn(async () => adminIdentity),
    } as unknown as PrivilegedAccessService;

    const result = await new PrivilegedAccessActivities(
      service,
      {} as PamSessionStateService,
      {} as PamSessionService,
    ).getOrCreateLinkedAdminIdentity('parent-1', 'TIER_1', 'tenant-a', 'wf-1');

    expect(service.createLinkedAdminIdentity).toHaveBeenCalledWith(
      'parent-1',
      'TIER_1',
      'tenant-a',
    );
    expect(result).toEqual({
      adminIdentityId: 'admin-1',
      adminEmail: 'adm-ada@corp.example',
      adminProfile: { ...profile, _id: 'admin-1' },
    });
  });
});
