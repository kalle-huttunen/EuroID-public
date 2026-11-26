/**
 * In-memory stand-ins for the stores behind bulk rollback, for workflow e2e tests that run the
 * real BulkProvisioningActivities: the rollback snapshot store (encryption is covered by
 * RollbackSnapshotService's own integration test) and the Golden Record (IdentityService).
 */
import type { RollbackSnapshotKind } from '../../src/modules/bulk-provisioning/schemas/rollback-snapshot.schema';
import type {
  HubBeforeWrite,
  IdentityHubState,
} from '../../src/modules/identity/identity-hub-state';

export class MemorySnapshots {
  readonly saved = new Map<
    string,
    { tenantId: string; kind: RollbackSnapshotKind; state: unknown }
  >();
  private readonly byKey = new Map<string, string>();

  async save(tenantId: string, kind: RollbackSnapshotKind, state: unknown, key?: string) {
    const existing = key ? this.byKey.get(`${tenantId}|${key}`) : undefined;
    if (existing) return existing;
    const ref = `snap-${this.saved.size + 1}`;
    this.saved.set(ref, { tenantId, kind, state: JSON.parse(JSON.stringify(state)) });
    if (key) this.byKey.set(`${tenantId}|${key}`, ref);
    return ref;
  }

  async load(tenantId: string, kind: RollbackSnapshotKind, ref: string) {
    const snapshot = this.saved.get(ref);
    return snapshot && snapshot.tenantId === tenantId && snapshot.kind === kind
      ? snapshot.state
      : null;
  }
}

/**
 * Golden Records keyed by email. saveOrUpdateReportingCreated reports the record it is about to
 * overwrite (or null for a new one) to beforeWrite, then calls `write` (a test mock that may fail,
 * like a Hub outage) and stores the user's profile.
 */
export class MemoryHub {
  readonly records = new Map<string, IdentityHubState>();
  readonly restoreHubState = jest.fn(async (id: string, state: IdentityHubState) => {
    if (!this.records.has(id)) return false;
    this.records.set(id, state);
    return true;
  });
  readonly removeIdentity = jest.fn(async (id: string) => this.records.delete(id));

  constructor(private readonly write: (user: unknown) => Promise<unknown>) {}

  async saveOrUpdateReportingCreated(user: { email: string }, beforeWrite?: HubBeforeWrite) {
    const id = `identity-${user.email}`;
    const existing = this.records.get(id);
    await beforeWrite?.(existing ? JSON.parse(JSON.stringify(existing)) : null);
    await this.write(user);
    this.records.set(id, {
      id,
      profile: { ...user },
      sources: [],
      metadata: {},
      deletedAt: null,
      deletedBy: null,
    });
    return { _id: id };
  }

  seed(email: string, profile: Record<string, unknown>): IdentityHubState {
    const state: IdentityHubState = {
      id: `identity-${email}`,
      profile: { email, ...profile },
      sources: [],
      metadata: { version: 1 },
      deletedAt: null,
      deletedBy: null,
    };
    this.records.set(state.id, state);
    return state;
  }
}
