/**
 * PolicyService.activate's policy.updated through the real DomainEventEmitterService (zod payload
 * schema) on the real Nest event emitter, to the real AuditEventHandler. The policy model and the
 * audit store are stubbed.
 *
 * Plan 2.0du: the payload carried activatedBy and previousStatus, which policyUpdatedSchema
 * stripped, so the audit entry did not say from which status the policy was activated, and who
 * activated it came only from the request context.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { AuditEventHandler } from '@infrastructure/events/handlers/audit-event.handler';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { AuditService } from '../audit/audit.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { PolicyService } from './policy.service';
import { Policy, PolicyStatus } from './schemas/policy.schema';

const POLICY_ID = '64b7f0c2a1b2c3d4e5f60719';
const TENANT = 'tenant-a';

/** Lets the setImmediate-scheduled audit handler (`async: true`) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('policy activation: policy.updated in the audit log', () => {
  let moduleRef: TestingModule;
  let service: PolicyService;
  const findById = jest.fn();
  const auditLog = jest.fn();
  const capture = jest.fn();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        PolicyService,
        AuditEventHandler,
        { provide: getModelToken(Policy.name), useValue: { findById } },
        { provide: EntitlementCatalogService, useValue: {} },
        { provide: AuditService, useValue: { log: auditLog } },
        {
          provide: DomainEventEmitterService,
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) =>
            new DomainEventEmitterService(
              emitter,
              { capture } as unknown as DeadLetterService,
              {} as never,
              { get: jest.fn().mockReturnValue('test') } as never,
            ),
        },
      ],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(PolicyService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    auditLog.mockReset().mockResolvedValue(undefined);
    capture.mockReset();
  });

  it('records who activated the policy and the status it was activated from', async () => {
    const policy = {
      _id: POLICY_ID,
      tenantId: TENANT,
      status: PolicyStatus.DISABLED,
      createdBy: 'alice@acme.com',
      save: jest.fn(function (this: unknown) {
        return Promise.resolve(this);
      }),
    };
    findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(policy) });

    // An activation outside a request (no request actor): the audit entry still names bob
    await withTenantContext(TENANT, () => service.activate(POLICY_ID, 'bob@acme.com'));
    await settle();

    expect(capture).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = auditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: DomainEventType.POLICY_UPDATED,
      actor: 'bob@acme.com',
      resourceType: 'policy',
      resourceId: POLICY_ID,
      payload: {
        metadata: {
          policyId: POLICY_ID,
          changedFields: ['status'],
          previousStatus: PolicyStatus.DISABLED,
        },
      },
    });
    // The payload also reaches the tenant websocket: the operator's email stays in the actor
    expect(entry.payload.metadata).not.toHaveProperty('activatedBy');
  });
});
