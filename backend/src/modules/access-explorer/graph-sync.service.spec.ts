import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { GraphSyncService } from './graph-sync.service';
import { GraphService } from '@infrastructure/graph/graph.service';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import {
  DiscoveryCompletedPayload,
  IdentityCreatedPayload,
  IdentityDeletedPayload,
  IdentityUpdatedPayload,
  OffboardingCompletedPayload,
  ProvisioningCompletedPayload,
} from '@infrastructure/events/event-payloads';

/** Build a minimal DomainEvent envelope for testing. */
function buildEvent<T>(
  type: DomainEventType,
  payload: T,
  tenantId = 'test-tenant',
): DomainEvent<T> {
  return {
    eventId: `evt-${Date.now()}`,
    type,
    aggregateId: 'agg-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: {
      correlationId: 'corr-1',
      depth: 0,
      emittedBy: 'test',
      actor: 'test-user',
      tenantId,
    },
  };
}

const IDENTITY_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('GraphSyncService', () => {
  let service: GraphSyncService;
  let graphService: jest.Mocked<GraphService>;
  /** The stored identity findOne answers (lean, profile.email only). */
  let stored: { profile?: { email?: string } } | null;
  const findOne = jest.fn((_filter: Record<string, unknown>) => ({
    select: () => ({ lean: () => ({ exec: async () => stored }) }),
  }));
  /** The entitlement catalog find answers (lean: system, nativeId, name, type). */
  let catalog: Array<{ system?: string; nativeId?: string; name: string; type: string }> | Error;
  const catalogFind = jest.fn((_filter: Record<string, unknown>) => ({
    select: () => ({
      lean: () => ({
        exec: async () => {
          if (catalog instanceof Error) throw catalog;
          return catalog;
        },
      }),
    }),
  }));

  beforeEach(async () => {
    graphService = {
      runQuery: jest.fn().mockResolvedValue({ records: [] }),
      runWriteQuery: jest.fn().mockResolvedValue({ records: [] }),
      healthCheck: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<GraphService>;
    stored = { profile: { email: 'john@example.com' } };
    findOne.mockClear();
    catalog = [];
    catalogFind.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GraphSyncService,
        { provide: GraphService, useValue: graphService },
        { provide: getModelToken('Identity'), useValue: { findOne } },
        { provide: getModelToken('EntitlementCatalog'), useValue: { find: catalogFind } },
      ],
    }).compile();

    service = module.get<GraphSyncService>(GraphSyncService);
  });

  // ── onIdentityCreated ──────────────────────────────────────────────

  describe('onIdentityCreated', () => {
    // Plan 2.8a: identity.created carries no email; the node gets the stored identity's
    it("merges the Identity node with the stored identity's email, in the event tenant", async () => {
      const event = buildEvent<IdentityCreatedPayload>(DomainEventType.IDENTITY_CREATED, {
        identityId: IDENTITY_ID,
        sourceSystem: 'Workday',
        sourceUserId: 'WD-001',
        status: 'ACTIVE',
      });

      await service.onIdentityCreated(event);

      expect(findOne).toHaveBeenCalledWith({ _id: IDENTITY_ID, tenantId: 'test-tenant' });
      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher).toContain('MERGE (i:Identity');
      expect(params!.id).toBe(IDENTITY_ID);
      expect(params!.tenantId).toBe('test-tenant');
      expect(params!.sourceSystem).toBe('Workday');
      expect(params!.status).toBe('ACTIVE');
      expect(params!.email).toBe('john@example.com');
    });

    it('passes null for an identity without an email, so the node keeps the one it has', async () => {
      stored = { profile: {} };
      const event = buildEvent<IdentityCreatedPayload>(DomainEventType.IDENTITY_CREATED, {
        identityId: IDENTITY_ID,
        sourceSystem: 'TestHR',
        status: 'PENDING',
      });

      await service.onIdentityCreated(event);

      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(params!.email).toBeNull();
      expect(cypher).toContain('i.email = coalesce($email, i.email)');
    });

    it('should catch and log errors without throwing (fail-open)', async () => {
      graphService.runWriteQuery.mockRejectedValue(new Error('Neo4j down'));

      const event = buildEvent<IdentityCreatedPayload>(DomainEventType.IDENTITY_CREATED, {
        identityId: 'id-003',
        sourceSystem: 'TestHR',
        sourceUserId: 'T-003',
        status: 'ACTIVE',
      });

      // Should NOT throw
      await expect(service.onIdentityCreated(event)).resolves.toBeUndefined();
    });
  });

  // ── onIdentityUpdated ──────────────────────────────────────────────

  describe('onIdentityUpdated', () => {
    it('should call runWriteQuery with MERGE Cypher for identity update', async () => {
      const event = buildEvent<IdentityUpdatedPayload>(DomainEventType.IDENTITY_UPDATED, {
        identityId: IDENTITY_ID,
        changedFields: ['department', 'jobTitle'],
        source: 'Workday',
      });

      await service.onIdentityUpdated(event);

      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher).toContain('MERGE (i:Identity');
      expect(params!.id).toBe(IDENTITY_ID);
      expect(params!.source).toBe('Workday');
      expect(params!.changedFields).toEqual(['department', 'jobTitle']);
    });

    // Plan 2.0dn: identity.updated carries no email (audit log, websocket, analytics index)
    it("sets the node's email from the identity as stored, in the event's tenant", async () => {
      stored = { profile: { email: 'john.new@example.com' } };
      const event = buildEvent<IdentityUpdatedPayload>(DomainEventType.IDENTITY_UPDATED, {
        identityId: IDENTITY_ID,
        changedFields: ['email'],
        source: 'writeback',
      });

      await service.onIdentityUpdated(event);

      expect(findOne).toHaveBeenCalledWith({ _id: IDENTITY_ID, tenantId: 'test-tenant' });
      const [, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(params!.email).toBe('john.new@example.com');
    });

    it('keeps the email of the node when the identity has none', async () => {
      stored = null;
      const event = buildEvent<IdentityUpdatedPayload>(DomainEventType.IDENTITY_UPDATED, {
        identityId: IDENTITY_ID,
        changedFields: ['status'],
        source: 'TestHR',
      });

      await service.onIdentityUpdated(event);

      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      // An empty string here blanked the email of an existing node.
      expect(params!.email).toBeNull();
      expect(cypher).toMatch(/ON MATCH SET[\s\S]*i\.email = coalesce\(\$email, i\.email\)/);
    });

    it('should catch and log errors without throwing (fail-open)', async () => {
      graphService.runWriteQuery.mockRejectedValue(new Error('Write failed'));

      const event = buildEvent<IdentityUpdatedPayload>(DomainEventType.IDENTITY_UPDATED, {
        identityId: 'id-004',
        changedFields: ['status'],
        source: 'TestHR',
      });

      await expect(service.onIdentityUpdated(event)).resolves.toBeUndefined();
    });
  });

  // ── onProvisioningCompleted ────────────────────────────────────────

  describe('onProvisioningCompleted', () => {
    it('should create HAS_ACCESS edges for successful add operations', async () => {
      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [
            { action: 'add', type: 'group', targetId: 'grp-eng', success: true },
            { action: 'add', type: 'license', targetId: 'lic-e5', success: true },
          ],
          durationMs: 1200,
        },
      );

      await service.onProvisioningCompleted(event);

      // Two add operations = two runWriteQuery calls
      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(2);

      const [cypher1, params1] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher1).toContain('MERGE (i:Identity');
      expect(cypher1).toContain('MERGE (e:Entitlement');
      expect(cypher1).toContain('MERGE (i)-[r:HAS_ACCESS]->(e)');
      expect(params1!.identityId).toBe('id-001');
      // Keyed by system and id (hunt 06 F3): a native id can repeat in another system
      expect(params1!.targetId).toBe('entra-id::grp-eng');
      expect(params1!.nativeId).toBe('grp-eng');
      expect(params1!.connector).toBe('entra-id');

      const [, params2] = graphService.runWriteQuery.mock.calls[1]!;
      expect(params2!.targetId).toBe('entra-id::lic-e5');
    });

    it('links nothing for an event without an identity id (bulk rows, PAM profiles)', async () => {
      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [{ action: 'add', type: 'group', targetId: 'grp-eng', success: true }],
          durationMs: 1200,
        },
      );

      await service.onProvisioningCompleted(event);

      expect(graphService.runWriteQuery).not.toHaveBeenCalled();
    });

    it('should delete HAS_ACCESS edges for successful remove operations', async () => {
      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [{ action: 'remove', type: 'group', targetId: 'grp-old', success: true }],
          durationMs: 800,
        },
      );

      await service.onProvisioningCompleted(event);

      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher).toContain('DELETE r');
      expect(params!.targetIds).toEqual(['entra-id::grp-old']);
    });

    // FOLLOWUPS 2026-11-25 (graph-sync.service.ts:228, :240): provisioning reports the target id
    // the rule names (a group's display name), which made a second node apart from the catalog's.
    describe("on the catalog's node, as the resync keys it", () => {
      const provisioned = (operations: ProvisioningCompletedPayload['operations']) =>
        buildEvent<ProvisioningCompletedPayload>(DomainEventType.PROVISIONING_COMPLETED, {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations,
          durationMs: 100,
        });

      beforeEach(() => {
        catalog = [{ system: 'entra-id', nativeId: 'grp-fin', name: 'Finance', type: 'Group' }];
      });

      it('links access a rule names by display name to its native id, a target it does not know to its own id', async () => {
        await service.onProvisioningCompleted(
          provisioned([
            { action: 'add', type: 'group', targetId: 'Finance', success: true },
            { action: 'add', type: 'group', targetId: 'SG-Unknown', success: true },
          ]),
        );

        expect(catalogFind).toHaveBeenCalledWith({
          tenantId: 'test-tenant',
          system: { $in: ['entra-id'] },
          nativeId: { $type: 'string', $ne: '' },
          $or: [
            { nativeId: { $in: ['Finance', 'SG-Unknown'] } },
            { name: { $in: ['Finance', 'SG-Unknown'] } },
          ],
        });
        const [[cypher, known], [, unknown]] = graphService.runWriteQuery.mock.calls;
        expect(cypher).toContain('MERGE (e:Entitlement {id: $targetId, tenantId: $tenantId})');
        // A node made here before discovery reaches the graph carries the catalog's name
        expect(cypher).toContain('e.name = $name');
        expect(known).toMatchObject({
          targetId: 'entra-id::grp-fin',
          nativeId: 'grp-fin',
          name: 'Finance',
        });
        expect(unknown).toMatchObject({
          targetId: 'entra-id::SG-Unknown',
          nativeId: 'SG-Unknown',
          name: null,
        });
      });

      it('removes the access from the native id and from the id the event names (an older edge)', async () => {
        await service.onProvisioningCompleted(
          provisioned([{ action: 'remove', type: 'group', targetId: 'Finance', success: true }]),
        );

        const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
        expect(cypher).toContain('WHERE e.id IN $targetIds');
        expect(params!.targetIds).toEqual(['entra-id::grp-fin', 'entra-id::Finance']);
      });

      it('writes nothing and does not throw when the catalog cannot be read (fail-open)', async () => {
        catalog = new Error('MongoDB down');

        await expect(
          service.onProvisioningCompleted(
            provisioned([{ action: 'add', type: 'group', targetId: 'Finance', success: true }]),
          ),
        ).resolves.toBeUndefined();
        expect(graphService.runWriteQuery).not.toHaveBeenCalled();
      });
    });

    it('should skip failed operations', async () => {
      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [
            { action: 'add', type: 'group', targetId: 'grp-ok', success: true },
            { action: 'add', type: 'group', targetId: 'grp-fail', success: false },
          ],
          durationMs: 500,
        },
      );

      await service.onProvisioningCompleted(event);

      // Only one call — the failed operation is skipped
      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      expect(graphService.runWriteQuery.mock.calls[0]![1]!.targetId).toBe('entra-id::grp-ok');
    });

    it('should handle empty operations array gracefully', async () => {
      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [],
          durationMs: 100,
        },
      );

      await service.onProvisioningCompleted(event);

      expect(graphService.runWriteQuery).not.toHaveBeenCalled();
    });

    it('should catch and log errors without throwing (fail-open)', async () => {
      graphService.runWriteQuery.mockRejectedValue(new Error('Graph write failed'));

      const event = buildEvent<ProvisioningCompletedPayload>(
        DomainEventType.PROVISIONING_COMPLETED,
        {
          identityId: 'id-001',
          connector: 'entra-id',
          targetUserId: 'entra-user-1',
          operations: [{ action: 'add', type: 'group', targetId: 'grp-1', success: true }],
          durationMs: 200,
        },
      );

      await expect(service.onProvisioningCompleted(event)).resolves.toBeUndefined();
    });
  });

  // ── onDiscoveryCompleted ───────────────────────────────────────────

  describe('onDiscoveryCompleted', () => {
    const discovery = (payload: DiscoveryCompletedPayload) =>
      buildEvent<DiscoveryCompletedPayload>(DomainEventType.DISCOVERY_COMPLETED, payload);

    it("writes the system's catalog entries with their names under its Application, in the event tenant", async () => {
      catalog = [
        { nativeId: 'grp-1', name: 'Engineers', type: 'Group' },
        { nativeId: 'lic-e5', name: 'Office E5', type: 'License' },
      ];

      await service.onDiscoveryCompleted(
        discovery({ system: 'entra-id', discovered: 2, removed: 0 }),
      );

      // The catalog as absorbDiscovered left it, entries with a native id only (as the resync)
      expect(catalogFind).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        system: 'entra-id',
        nativeId: { $nin: [null, ''] },
      });
      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher).toContain('MERGE (a:Application {id: $system, tenantId: $tenantId})');
      expect(cypher).toContain('MERGE (e:Entitlement {id: row.id, tenantId: $tenantId})');
      expect(cypher).toContain('MERGE (e)-[:BELONGS_TO]->(a)');
      // A resync's stamp stays: an event must not make a running resync remove the node
      expect(cypher).not.toContain('syncRunId');
      expect(params).toEqual({
        tenantId: 'test-tenant',
        system: 'entra-id',
        rows: [
          { id: 'entra-id::grp-1', nativeId: 'grp-1', name: 'Engineers', type: 'Group' },
          { id: 'entra-id::lic-e5', nativeId: 'lic-e5', name: 'Office E5', type: 'License' },
        ],
      });
    });

    it('still writes the Application when the system has no entry with a native id', async () => {
      await service.onDiscoveryCompleted(discovery({ system: 'okta', discovered: 0, removed: 3 }));

      const [cypher, params] = graphService.runWriteQuery.mock.calls[0]!;
      expect(cypher).toMatch(/MERGE \(a:Application[\s\S]*UNWIND \$rows/);
      expect(params!.rows).toEqual([]);
    });

    it('logs and does not throw when the catalog read or the write fails (fail-open)', async () => {
      catalog = new Error('MongoDB down');
      await expect(
        service.onDiscoveryCompleted(discovery({ system: 'ad', discovered: 1, removed: 0 })),
      ).resolves.toBeUndefined();
      expect(graphService.runWriteQuery).not.toHaveBeenCalled();

      catalog = [{ nativeId: 'grp-1', name: 'Test', type: 'Group' }];
      graphService.runWriteQuery.mockRejectedValue(new Error('Write fail'));
      await expect(
        service.onDiscoveryCompleted(discovery({ system: 'ad', discovered: 1, removed: 0 })),
      ).resolves.toBeUndefined();
    });
  });

  // ── Deleted and offboarded identities ──────────────────────────────

  describe('removing a deleted identity', () => {
    const removal = (call: number) => graphService.runWriteQuery.mock.calls[call]!;

    it("removes the identity's node and its edges in the event tenant on identity.deleted", async () => {
      await service.onIdentityDeleted(
        buildEvent<IdentityDeletedPayload>(DomainEventType.IDENTITY_DELETED, {
          identityId: IDENTITY_ID,
          reason: 'offboarding-workflow',
        }),
      );

      expect(graphService.runWriteQuery).toHaveBeenCalledTimes(1);
      const [cypher, params] = removal(0);
      expect(cypher).toContain('MATCH (i:Identity {id: $id, tenantId: $tenantId})');
      expect(cypher).toContain('DETACH DELETE i');
      expect(params).toEqual({ id: IDENTITY_ID, tenantId: 'test-tenant' });
    });

    const offboarding = (hubStatus: 'deleted' | 'suspended') =>
      buildEvent<OffboardingCompletedPayload>(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, {
        identityId: IDENTITY_ID,
        workflowId: 'offboarding-1',
        status: hubStatus === 'deleted' ? 'completed' : 'partial-failure',
        hubStatus,
        systems: [
          {
            system: 'entra-id',
            outcome: hubStatus === 'deleted' ? 'deprovisioned' : 'failed',
          },
        ],
      });

    it('removes the node when the offboarding deleted the Golden Record', async () => {
      await service.onOffboardingCompleted(offboarding('deleted'));

      const [cypher, params] = removal(0);
      expect(cypher).toContain('DETACH DELETE i');
      expect(params).toEqual({ id: IDENTITY_ID, tenantId: 'test-tenant' });
    });

    it('keeps the node of a suspended offboarding: its failed targets still have the account', async () => {
      await service.onOffboardingCompleted(offboarding('suspended'));

      expect(graphService.runWriteQuery).not.toHaveBeenCalled();
    });

    it('logs and does not throw when the removal fails (fail-open)', async () => {
      graphService.runWriteQuery.mockRejectedValue(new Error('Neo4j down'));

      await expect(
        service.onIdentityDeleted(
          buildEvent<IdentityDeletedPayload>(DomainEventType.IDENTITY_DELETED, {
            identityId: IDENTITY_ID,
            reason: 'rollback',
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
