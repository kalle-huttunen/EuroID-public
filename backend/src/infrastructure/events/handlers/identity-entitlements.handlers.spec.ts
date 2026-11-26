import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import type { DomainEvent } from '../domain-event.interface';
import { DomainEventType } from '../event-types';
import type { IdentityEntitlementsQueryPayload } from '../event-payloads';
import { IdentityService } from '../../../modules/identity/identity.service';
import {
  PolicyEngineService,
  type ProvisioningOperation,
} from '../../../modules/policy/policy-engine.service';
import { AccessRequestsService } from '../../../modules/access-requests/access-requests.service';
import { IdentityEntitlementsPolicyHandler } from './identity-entitlements-policy.handler';
import { IdentityEntitlementsRequestHandler } from './identity-entitlements-request.handler';

const IDENTITY_ID = '507f1f77bcf86cd799439011';

function queryEvent(): DomainEvent<IdentityEntitlementsQueryPayload> {
  return {
    eventId: 'evt-1',
    type: DomainEventType.IDENTITY_ENTITLEMENTS_QUERY,
    aggregateId: IDENTITY_ID,
    timestamp: new Date().toISOString(),
    payload: { identityId: IDENTITY_ID },
    metadata: {
      correlationId: 'c-1',
      depth: 0,
      emittedBy: 'test',
      actor: 'test',
      tenantId: 'tenant-a',
    },
  };
}

function op(overrides: Partial<ProvisioningOperation>): ProvisioningOperation {
  return {
    type: 'group',
    action: 'add',
    target: 'entra-id',
    targetId: 'SG-Engineering',
    sourcePolicy: 'Engineering birthright',
    ...overrides,
  };
}

describe('IdentityEntitlementsPolicyHandler', () => {
  const plainIdentity = { _id: IDENTITY_ID, profile: { email: 'ada@example.com' } };
  // Stands in for a hydrated Mongoose document: fields only reachable via toObject().
  const identityDoc = { toObject: () => plainIdentity };
  const profile = { email: 'ada@example.com', departmentName: 'Engineering' };
  let identityService: {
    findIdentityById: jest.Mock;
    buildProfileWithContractsForPolicy: jest.Mock;
  };
  let policyEngine: { evaluateOperationsWithoutSod: jest.Mock };
  let handler: IdentityEntitlementsPolicyHandler;

  beforeEach(() => {
    identityService = {
      findIdentityById: jest.fn().mockResolvedValue(identityDoc),
      buildProfileWithContractsForPolicy: jest.fn().mockResolvedValue(profile),
    };
    policyEngine = { evaluateOperationsWithoutSod: jest.fn().mockResolvedValue([]) };
    handler = new IdentityEntitlementsPolicyHandler(
      identityService as unknown as IdentityService,
      policyEngine as unknown as PolicyEngineService,
    );
  });

  it('evaluates active policies against the plain identity profile for the event tenant', async () => {
    await handler.handleEntitlementsQuery(queryEvent());

    expect(identityService.findIdentityById).toHaveBeenCalledWith(IDENTITY_ID);
    expect(identityService.buildProfileWithContractsForPolicy).toHaveBeenCalledWith(plainIdentity);
    expect(policyEngine.evaluateOperationsWithoutSod).toHaveBeenCalledWith(profile, 'tenant-a');
  });

  it('returns group, license and role additions as policy grants', async () => {
    policyEngine.evaluateOperationsWithoutSod.mockResolvedValue([
      op({}),
      op({ type: 'license', targetId: 'E5', sourcePolicy: 'All staff' }),
      op({ type: 'role', target: 'okta', targetId: 'Admin', sourcePolicy: 'IT admins' }),
      op({ type: 'attribute', targetId: 'department' }),
      op({ type: 'mfa', targetId: 'authenticator' }),
      op({ action: 'remove', targetId: 'SG-Legacy' }),
    ]);

    const result = await handler.handleEntitlementsQuery(queryEvent());

    expect(result).toEqual({
      kind: 'identity-entitlements',
      grants: [
        {
          grantedBy: 'policy',
          entitlement: 'SG-Engineering',
          type: 'group',
          targetSystem: 'entra-id',
          source: 'Engineering birthright',
        },
        {
          grantedBy: 'policy',
          entitlement: 'E5',
          type: 'license',
          targetSystem: 'entra-id',
          source: 'All staff',
        },
        {
          grantedBy: 'policy',
          entitlement: 'Admin',
          type: 'role',
          targetSystem: 'okta',
          source: 'IT admins',
        },
      ],
    });
  });

  it('returns no grants when the identity is not found in the tenant', async () => {
    identityService.findIdentityById.mockResolvedValue(null);

    const result = await handler.handleEntitlementsQuery(queryEvent());

    expect(result).toEqual({ kind: 'identity-entitlements', grants: [] });
    expect(policyEngine.evaluateOperationsWithoutSod).not.toHaveBeenCalled();
  });

  it('propagates policy evaluation failures instead of reporting an empty list', async () => {
    policyEngine.evaluateOperationsWithoutSod.mockRejectedValue(new Error('policy store down'));

    await expect(handler.handleEntitlementsQuery(queryEvent())).rejects.toThrow(
      'policy store down',
    );
  });
});

describe('IdentityEntitlementsRequestHandler', () => {
  let accessRequestsService: { findActiveRequestsForIdentity: jest.Mock };
  let handler: IdentityEntitlementsRequestHandler;

  beforeEach(() => {
    accessRequestsService = { findActiveRequestsForIdentity: jest.fn().mockResolvedValue([]) };
    handler = new IdentityEntitlementsRequestHandler(
      accessRequestsService as unknown as AccessRequestsService,
    );
  });

  it('returns each entitlement of the identity active and provisioning requests', async () => {
    accessRequestsService.findActiveRequestsForIdentity.mockResolvedValue([
      {
        requestId: 'AR-1',
        status: 'ACTIVE',
        entitlements: [
          { system: 'entra-id', entitlementName: 'Finance-RO', entitlementType: 'Group' },
          { system: 'entra-id', entitlementName: 'Visio', entitlementType: 'License' },
        ],
      },
      {
        requestId: 'AR-2',
        status: 'PROVISIONING',
        entitlements: [{ system: 'servicenow', entitlementName: 'itil' }],
      },
    ]);

    const result = await handler.handleEntitlementsQuery(queryEvent());

    expect(accessRequestsService.findActiveRequestsForIdentity).toHaveBeenCalledWith(IDENTITY_ID);
    expect(result).toEqual({
      kind: 'identity-entitlements',
      grants: [
        {
          grantedBy: 'request',
          entitlement: 'Finance-RO',
          type: 'group',
          targetSystem: 'entra-id',
          source: 'Access request AR-1',
          requestStatus: 'ACTIVE',
        },
        {
          grantedBy: 'request',
          entitlement: 'Visio',
          type: 'license',
          targetSystem: 'entra-id',
          source: 'Access request AR-1',
          requestStatus: 'ACTIVE',
        },
        {
          grantedBy: 'request',
          entitlement: 'itil',
          type: 'group',
          targetSystem: 'servicenow',
          source: 'Access request AR-2',
          requestStatus: 'PROVISIONING',
        },
      ],
    });
  });

  it('carries the end date of a time-bound request (granted, else requested)', async () => {
    accessRequestsService.findActiveRequestsForIdentity.mockResolvedValue([
      {
        requestId: 'AR-1',
        status: 'ACTIVE',
        expiresAt: new Date('2027-06-01T00:00:00.000Z'),
        timeConstraint: { requestedDurationDays: 200, expiresAt: new Date('2027-05-30') },
        entitlements: [{ system: 'entra-id', entitlementName: 'Finance-RO' }],
      },
      {
        requestId: 'AR-2',
        status: 'PROVISIONING',
        timeConstraint: {
          requestedDurationDays: 30,
          expiresAt: new Date('2026-12-24T00:00:00.000Z'),
        },
        entitlements: [{ system: 'entra-id', entitlementName: 'Finance-RW' }],
      },
      {
        requestId: 'AR-3',
        status: 'ACTIVE',
        entitlements: [{ system: 'entra-id', entitlementName: 'Visio' }],
      },
    ]);

    const result = await handler.handleEntitlementsQuery(queryEvent());

    expect(result.grants.map((g) => [g.entitlement, g.expiresAt])).toEqual([
      ['Finance-RO', '2027-06-01T00:00:00.000Z'],
      ['Finance-RW', '2026-12-24T00:00:00.000Z'],
      ['Visio', undefined],
    ]);
    expect(result.grants[2]).not.toHaveProperty('expiresAt');
  });

  it('returns no grants when the identity has no active requests', async () => {
    const result = await handler.handleEntitlementsQuery(queryEvent());
    expect(result).toEqual({ kind: 'identity-entitlements', grants: [] });
  });
});

/**
 * Registers both handlers on the real Nest event emitter (same EventEmitter2 options as
 * EventsModule) and calls emitAsync the way DomainEventEmitterService.emitAndWait does.
 * Guards the listener options: with `async: true` the results never reach the caller.
 */
describe('identity.entitlements_query wiring', () => {
  let moduleRef: TestingModule;
  let emitter: EventEmitter2;
  const evaluateOperationsWithoutSod = jest.fn();
  const findActiveRequestsForIdentity = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        IdentityEntitlementsPolicyHandler,
        IdentityEntitlementsRequestHandler,
        {
          provide: IdentityService,
          useValue: {
            findIdentityById: jest.fn().mockResolvedValue({ toObject: () => ({}) }),
            buildProfileWithContractsForPolicy: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: PolicyEngineService, useValue: { evaluateOperationsWithoutSod } },
        { provide: AccessRequestsService, useValue: { findActiveRequestsForIdentity } },
      ],
    }).compile();
    await moduleRef.init();
    emitter = moduleRef.get(EventEmitter2);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('hands both handler results back to the emitter', async () => {
    evaluateOperationsWithoutSod.mockResolvedValue([op({})]);
    findActiveRequestsForIdentity.mockResolvedValue([
      {
        requestId: 'AR-1',
        status: 'ACTIVE',
        entitlements: [{ system: 'entra-id', entitlementName: 'Finance-RO' }],
      },
    ]);

    const results = await emitter.emitAsync(
      DomainEventType.IDENTITY_ENTITLEMENTS_QUERY,
      queryEvent(),
    );

    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        {
          kind: 'identity-entitlements',
          grants: [expect.objectContaining({ grantedBy: 'policy', entitlement: 'SG-Engineering' })],
        },
        {
          kind: 'identity-entitlements',
          grants: [expect.objectContaining({ grantedBy: 'request', entitlement: 'Finance-RO' })],
        },
      ]),
    );
  });

  it('rejects when a handler fails instead of reporting no entitlements', async () => {
    evaluateOperationsWithoutSod.mockResolvedValue([]);
    findActiveRequestsForIdentity.mockRejectedValueOnce(new Error('access request store down'));

    await expect(
      emitter.emitAsync(DomainEventType.IDENTITY_ENTITLEMENTS_QUERY, queryEvent()),
    ).rejects.toThrow('access request store down');
  });
});
