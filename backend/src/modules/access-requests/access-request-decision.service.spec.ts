/**
 * Approve, reject and delegate log who decided with the email masked (identity-pii maskEmail):
 * the approver's and the delegate's addresses must not reach the logs in clear.
 */
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AccessRequestDecisionService } from './access-request-decision.service';
import { AccessRequestQueryService } from './access-request-query.service';
import { AccessRequestClosureService } from './access-request-closure.service';
import { AccessRequest } from './schemas/access-request.schema';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: () => 'test-tenant',
}));

const APPROVER = 'anna.approver@example.com';
const DELEGATE = 'dave.delegate@example.com';

describe('AccessRequestDecisionService: decision logs', () => {
  let service: AccessRequestDecisionService;
  let logged: string[];

  beforeEach(async () => {
    const doc = {
      requestId: 'req-1',
      status: 'PENDING_APPROVAL',
      requesterId: 'id-requester',
      requesterEmail: 'requester@example.com',
      workflowId: 'wf-1',
      approvalSteps: [
        {
          stepOrder: 0,
          approverType: 'USER',
          approverId: 'id-approver',
          approverEmail: APPROVER,
          status: 'PENDING',
        },
      ],
    };
    const model = {
      findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(doc) })),
      updateOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessRequestDecisionService,
        { provide: getModelToken(AccessRequest.name), useValue: model },
        {
          provide: IDENTITY_QUERY_PORT,
          useValue: {
            findByEmail: jest.fn().mockResolvedValue({ _id: 'id-delegate', email: DELEGATE }),
            findById: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: TemporalClientProvider,
          useValue: {
            getClient: () => ({ workflow: { getHandle: () => ({ signal: jest.fn() }) } }),
          },
        },
        {
          provide: AccessRequestQueryService,
          useValue: {
            approverRoleOf: jest.fn().mockResolvedValue(null),
            isStepApprover: jest.fn().mockReturnValue(true),
          },
        },
        { provide: AccessRequestClosureService, useValue: { close: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(AccessRequestDecisionService);

    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('approve logs the approver masked', async () => {
    await service.approve('req-1', 0, 'id-approver', APPROVER, 'needed');

    expect(logged).toContain('[AccessRequest] req-1 step 0 approved by a•••@example.com');
    expect(logged.join('\n')).not.toContain(APPROVER);
  });

  it('reject logs the approver masked', async () => {
    await service.reject('req-1', 0, 'id-approver', APPROVER, 'not needed');

    expect(logged).toContain('[AccessRequest] req-1 rejected by a•••@example.com');
    expect(logged.join('\n')).not.toContain(APPROVER);
  });

  it('delegate logs the approver and the delegate masked', async () => {
    await service.delegate('req-1', 0, 'id-approver', APPROVER, DELEGATE);

    expect(logged).toContain(
      '[AccessRequest] req-1 step 0 delegated by a•••@example.com to d•••@example.com',
    );
    const all = logged.join('\n');
    expect(all).not.toContain(APPROVER);
    expect(all).not.toContain(DELEGATE);
  });
});
