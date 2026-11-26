/**
 * The DSAR export's views of the erasure scope (HX-G3): the subject's own records with their
 * fields, minus bookkeeping and other people's personal data (GDPR Art. 15(4)).
 */
import {
  accessRequestView,
  agentView,
  ownFields,
  peerGroupView,
  pickedFields,
} from './dsar-scope-views';

const SUBJECT = 'id-ada';

describe('DSAR views of the erasure scope', () => {
  it('keeps every field but bookkeeping and the paths naming someone else, also inside arrays', () => {
    const view = ownFields('decidedBy', 'evidence.details.actors', 'steps.by');

    expect(
      view(
        {
          _id: 'x',
          tenantId: 't',
          __v: 3,
          identityId: SUBJECT,
          decidedBy: 'admin@corp.example',
          evidence: { pattern: 'off-hours', details: { count: 2, actors: ['admin@corp.example'] } },
          steps: [{ at: 1, by: 'a@corp.example' }, { at: 2 }],
        },
        SUBJECT,
      ),
    ).toEqual({
      _id: 'x',
      identityId: SUBJECT,
      evidence: { pattern: 'off-hours', details: { count: 2 } },
      steps: [{ at: 1 }, { at: 2 }],
    });
  });

  it('picks only the named fields of a record that belongs to something else', () => {
    expect(
      pickedFields('agentId', 'status')(
        { agentId: 'bot-1', status: 'active', credentialFingerprint: 'sha256:..', createdBy: 'x' },
        SUBJECT,
      ),
    ).toEqual({ agentId: 'bot-1', status: 'active' });
  });

  // Final review RC2: who created or revoked the subject's agent is the subject's own data when
  // it is the subject (an admin who made an agent for themselves), else another person's
  describe("the subject's NHI agent", () => {
    const agent = {
      agentId: 'bot-1',
      status: 'revoked',
      owner: { identityId: 'id-1', email: 'ada@x.example' },
      credentialFingerprint: 'sha256:..',
    };

    it('gives who created or revoked it when that was the subject', () => {
      expect(
        agentView({ ...agent, createdBy: 'Ada@X.example', revokedBy: 'ada@x.example' }, 'id-1'),
      ).toMatchObject({ createdBy: 'Ada@X.example', revokedBy: 'ada@x.example' });
    });

    it('leaves out another person who created or revoked it, and the fingerprint', () => {
      const view = agentView(
        { ...agent, createdBy: 'admin@x.example', revokedBy: 'sec@x.example' },
        'id-1',
      );
      expect(view).not.toHaveProperty('createdBy');
      expect(view).not.toHaveProperty('revokedBy');
      expect(view).not.toHaveProperty('credentialFingerprint');
      expect(view).toMatchObject({ agentId: 'bot-1', owner: agent.owner });
    });
  });

  describe('an access request', () => {
    const request = {
      tenantId: 't',
      requestId: 'r-1',
      requesterId: 'id-manager',
      requesterEmail: 'manager@corp.example',
      targetIdentityId: SUBJECT,
      status: 'EXPIRED',
      approvalSteps: [
        {
          stepOrder: 0,
          approverType: 'MANAGER',
          approverId: 'id-boss',
          approverEmail: 'boss@corp.example',
          status: 'APPROVED',
          justification: 'needed for the audit',
          decidedBy: 'boss@corp.example',
          delegatedFrom: 'other@corp.example',
        },
        { stepOrder: 1, approverType: 'ROLE', approverId: 'policy-admin', status: 'APPROVED' },
      ],
      removedManually: { by: 'admin@corp.example', at: 'when', note: 'removed in Entra ID' },
    };

    it('leaves out the manager who requested it, the approvers and the admin who closed it', () => {
      const view = accessRequestView(request, SUBJECT);

      expect(view).not.toHaveProperty('requesterId');
      expect(view).not.toHaveProperty('requesterEmail');
      expect(view).not.toHaveProperty('tenantId');
      expect(view.approvalSteps).toEqual([
        {
          stepOrder: 0,
          approverType: 'MANAGER',
          status: 'APPROVED',
          justification: 'needed for the audit',
        },
        // A ROLE step names a role, not a person
        { stepOrder: 1, approverType: 'ROLE', approverId: 'policy-admin', status: 'APPROVED' },
      ]);
      expect(view.removedManually).toEqual({ at: 'when', note: 'removed in Entra ID' });
      expect(JSON.stringify(view)).not.toMatch(/@corp\.example/);
    });

    it("keeps the requester when it is the subject's own request", () => {
      const own = { ...request, requesterId: SUBJECT, requesterEmail: 'ada@corp.example' };

      expect(accessRequestView(own, SUBJECT)).toMatchObject({
        requesterId: SUBJECT,
        requesterEmail: 'ada@corp.example',
      });
    });
  });

  it("gives a peer group without its members, with the subject's own outlier entry only", () => {
    const view = peerGroupView(
      {
        groupKey: 'Finance|Analyst',
        memberCount: 3,
        memberIds: [SUBJECT, 'id-b', 'id-c'],
        outliers: [
          { identityId: SUBJECT, deviationScore: 70 },
          { identityId: 'id-b', deviationScore: 90 },
        ],
      },
      SUBJECT,
    );

    expect(view).toEqual({
      groupKey: 'Finance|Analyst',
      memberCount: 3,
      outliers: [{ identityId: SUBJECT, deviationScore: 70 }],
    });
  });
});
