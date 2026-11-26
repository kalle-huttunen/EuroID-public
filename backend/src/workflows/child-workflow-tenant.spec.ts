const mockPatched = jest.fn((_id: string) => true);
const mockWorkflowInfo = jest.fn();

jest.mock('@temporalio/workflow', () => ({
  patched: (id: string) => mockPatched(id),
  workflowInfo: () => mockWorkflowInfo(),
}));

import { inheritTenantAttributes } from './child-workflow-tenant';

const PATCH = 'reconciliation:child-tenant-attributes';

describe('inheritTenantAttributes', () => {
  beforeEach(() => {
    mockPatched.mockReset().mockReturnValue(true);
    mockWorkflowInfo.mockReset().mockReturnValue({
      workflowId: 'parent-1',
      searchAttributes: { TenantId: ['tenant-a'], Other: ['x'] },
      memo: { triggeredBy: 'ReconciliationService', targetDescription: 'Daily recon' },
    });
  });

  it("gives the child the parent's TenantId and memo", () => {
    expect(inheritTenantAttributes(PATCH)).toEqual({
      searchAttributes: { TenantId: ['tenant-a'] },
      memo: { triggeredBy: 'ReconciliationService', targetDescription: 'Daily recon' },
    });
    expect(mockPatched).toHaveBeenCalledWith(PATCH);
  });

  it('adds nothing when replaying a history from before the patch', () => {
    mockPatched.mockReturnValue(false);

    expect(inheritTenantAttributes(PATCH)).toEqual({});
    expect(mockWorkflowInfo).not.toHaveBeenCalled();
  });

  it('adds no TenantId for a parent started without one, and no memo for a parent without', () => {
    mockWorkflowInfo.mockReturnValue({ workflowId: 'parent-1', searchAttributes: {} });

    expect(inheritTenantAttributes(PATCH)).toEqual({});
  });

  it('rejects a patch id outside the <workflow>:<change> convention', () => {
    expect(() => inheritTenantAttributes('child tenant')).toThrow(/Invalid patch ID/);
  });
});
