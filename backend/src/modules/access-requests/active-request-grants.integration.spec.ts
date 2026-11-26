/**
 * activeRequestGrants on in-memory MongoDB: which entitlements of an identity's access requests
 * the mover and its preview keep (an active request still grants them).
 */
import mongoose, { Connection, Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { activeRequestGrants } from './active-request-grants';
import { PROVISIONING_STALE_AFTER_MS } from './held-requests';
import {
  AccessRequest,
  AccessRequestSchema,
  type AccessRequestDocument,
} from './schemas/access-request.schema';

describe('activeRequestGrants (MongoDB)', () => {
  let connection: Connection;
  let model: Model<AccessRequestDocument>;

  beforeAll(async () => {
    connection = await mongoose.createConnection(testDbUri()).asPromise();
    model = connection.model(
      AccessRequest.name,
      AccessRequestSchema,
    ) as unknown as Model<AccessRequestDocument>;
  });

  afterAll(async () => {
    await connection?.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await model.collection.deleteMany({});
  });

  let seq = 0;
  const entitlement = (system: string, nativeId?: string, entitlementType?: string) => ({
    catalogEntryId: `cat-${nativeId ?? 'none'}`,
    system,
    entitlementName: nativeId ?? 'unnamed',
    justification: 'needed',
    ...(nativeId ? { nativeId } : {}),
    ...(entitlementType ? { entitlementType } : {}),
  });
  const request = (over: Record<string, unknown>) =>
    model.collection.insertOne({
      requestId: `req-${++seq}`,
      tenantId: 'tenant-a',
      requesterId: 'requester-1',
      requesterEmail: 'r@acme.test',
      status: 'ACTIVE',
      entitlements: [],
      ...over,
    });

  it("returns the native ids of the identity's ACTIVE and PROVISIONING requests, by operation type", async () => {
    await request({
      targetIdentityId: 'id-1',
      entitlements: [
        entitlement('entra-id', 'g-sales', 'Group'),
        entitlement('entra-id', 'E3', 'License'),
        entitlement('entra-id', 'role-helpdesk', 'DirectoryRole'),
      ],
    });
    await request({
      targetIdentityId: 'id-1',
      status: 'PROVISIONING',
      entitlements: [entitlement('okta', 'okta-sales')],
    });
    // Its own request, made for no one else
    await request({ requesterId: 'id-1', entitlements: [entitlement('ad', 'CN=Sales')] });

    const grants = await activeRequestGrants(model, 'tenant-a', 'id-1');

    expect(grants).toEqual(
      expect.arrayContaining([
        { system: 'entra-id', type: 'group', nativeId: 'g-sales' },
        { system: 'entra-id', type: 'license', nativeId: 'E3' },
        { system: 'entra-id', type: 'role', nativeId: 'role-helpdesk' },
        { system: 'okta', type: 'group', nativeId: 'okta-sales' },
        { system: 'ad', type: 'group', nativeId: 'CN=Sales' },
      ]),
    );
    expect(grants).toHaveLength(5);
  });

  it('leaves out ended requests, entitlements without a native id, other identities and tenants', async () => {
    for (const status of ['PENDING', 'REJECTED', 'EXPIRED', 'REVOKED', 'CANCELLED']) {
      await request({
        targetIdentityId: 'id-1',
        status,
        entitlements: [entitlement('entra-id', `g-${status}`)],
      });
    }
    await request({ targetIdentityId: 'id-1', entitlements: [entitlement('entra-id')] });
    await request({ targetIdentityId: 'id-2', entitlements: [entitlement('entra-id', 'g-other')] });
    // Asked by id-1 for someone else
    await request({
      requesterId: 'id-1',
      targetIdentityId: 'id-3',
      entitlements: [entitlement('entra-id', 'g-for-3')],
    });
    await request({
      tenantId: 'tenant-b',
      targetIdentityId: 'id-1',
      entitlements: [entitlement('entra-id', 'g-tenant-b')],
    });

    await expect(activeRequestGrants(model, 'tenant-a', 'id-1')).resolves.toEqual([]);
  });

  // Final review AG5: a request left PROVISIONING by a lost run must not keep a ghost grant
  it('leaves out a request PROVISIONING for longer than PROVISIONING_STALE_AFTER_MS', async () => {
    const now = Date.now();
    await request({
      targetIdentityId: 'id-1',
      status: 'PROVISIONING',
      updatedAt: new Date(now - PROVISIONING_STALE_AFTER_MS - 60_000),
      entitlements: [entitlement('entra-id', 'g-stale')],
    });
    await request({
      targetIdentityId: 'id-1',
      status: 'PROVISIONING',
      updatedAt: new Date(now - 60_000),
      entitlements: [entitlement('entra-id', 'g-fresh')],
    });
    // ACTIVE counts whatever its last update
    await request({
      targetIdentityId: 'id-1',
      updatedAt: new Date(now - 10 * PROVISIONING_STALE_AFTER_MS),
      entitlements: [entitlement('entra-id', 'g-active')],
    });

    const grants = await activeRequestGrants(model, 'tenant-a', 'id-1');

    expect(grants.map((g) => g.nativeId).sort()).toEqual(['g-active', 'g-fresh']);
  });
});
