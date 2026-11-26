/**
 * One agent in a centered modal, re-read from GET /nhi/:agentId: owner, scope, delegation,
 * expiry, the last credential and any revocation. Super-admins get the actions the agent's status
 * allows (issue a credential, delegate, revoke, kill switch), each in its own modal; the footer
 * says why an action is not offered. On a revoked agent whose cascade stopped part way (delegated
 * agents still active), they can finish it: the same revoke or kill switch again, which the API
 * completes and which leaves every agent already ended as it is. Other roles read only. The body scrolls under a fixed title
 * and footer, so the actions stay in reach on a phone.
 */
import React, { useState } from 'react';
import { Alert, Button, Descriptions, Modal, Space, Tag, Typography } from 'antd';
import {
  ApartmentOutlined,
  BranchesOutlined,
  UserSwitchOutlined,
  KeyOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useAgent, useEndAgentPreview } from '@api/nhi-api';
import { usePermission } from '../../auth/usePermission';
import type { IAgentIdentity } from '../../interfaces';
import { identityPath } from '../users/identity-path';
import { AgentFormModal } from './AgentFormModal';
import { AgentStatusTags } from './AgentTable';
import { ChangeOwnerModal } from './ChangeOwnerModal';
import { IssueCredentialModal } from './IssueCredentialModal';
import { RevokeAgentModal, type EndAction } from './RevokeAgentModal';
import {
  KIND_LABEL,
  RISK_LABEL,
  OWNERLESS_REASON,
  RISK_TAG,
  delegateBlocker,
  formatDateTime,
  isOwnerless,
  issueBlocker,
  killBlocker,
  revokeBlocker,
} from './nhi-labels';

const { Text } = Typography;

/** Room for the scope and revocation lines; on narrow screens Ant Design caps it at the viewport. */
const MODAL_WIDTH = 760;

type SubModal = 'delegate' | 'issue' | 'owner' | EndAction;

/** Why actions are not offered, one line each; a revoked agent gets one line for all. */
function blockedNote(agent: IAgentIdentity, signingEnabled: boolean | undefined): string[] {
  if (agent.killSwitchEngaged)
    return ['The kill switch is engaged: the agent is revoked for good.'];
  if (agent.status === 'revoked') {
    return [
      'Revocation is terminal: no credential, no delegation and no second revoke of the agent itself. The kill switch can still be engaged, for an agent found compromised after its revocation.',
    ];
  }
  const lines: Array<[string, string | undefined]> = [
    ['Issue credential', issueBlocker(agent, signingEnabled)],
    ['Delegate', delegateBlocker(agent)],
  ];
  return lines.filter(([, why]) => why).map(([name, why]) => `${name} is not available: ${why}`);
}

export const AgentDetailModal: React.FC<{
  /** The row the modal opened from; the agent is re-read by its agentId. */
  row: IAgentIdentity | null;
  /** GET /nhi/_/credential-signing-status; undefined when unknown. */
  signingEnabled?: boolean;
  onClose: () => void;
}> = ({ row, signingEnabled, onClose }) => {
  const isSuperAdmin = usePermission('super-admin');
  const detail = useAgent(row?.agentId);
  const [sub, setSub] = useState<SubModal | null>(null);
  const agent = detail.data ?? row;
  const revoked = agent?.status === 'revoked';
  // Finishing repeats what ended the agent: the kill switch once engaged, else the revoke
  const finishAction: EndAction = agent?.killSwitchEngaged ? 'kill' : 'revoke';
  const pending = useEndAgentPreview(agent?.agentId ?? '', finishAction, isSuperAdmin && revoked);
  if (!agent) return null;
  // Still active below a revoked agent; unknown when the dry run failed (the API decides then)
  const stillActive = pending.data?.reached.length ?? 0;
  const canFinish = isSuperAdmin && revoked && (stillActive > 0 || pending.isError);

  const notes = isSuperAdmin
    ? blockedNote(agent, signingEnabled)
    : ['Issuing credentials, delegating, revoking and the kill switch need the super-admin role.'];

  const footer = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        textAlign: 'start',
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, flex: '1 1 240px' }}>
        {notes.map((line) => (
          <span key={line} style={{ display: 'block' }}>
            {line}
          </span>
        ))}
      </Text>
      {isSuperAdmin && (
        <Space wrap>
          {isOwnerless(agent) && (
            <Button icon={<UserSwitchOutlined />} onClick={() => setSub('owner')}>
              Change owner
            </Button>
          )}
          {canFinish && (
            <Button danger icon={<ApartmentOutlined />} onClick={() => setSub(finishAction)}>
              Finish cascade
            </Button>
          )}
          <Button
            icon={<KeyOutlined />}
            disabled={!!issueBlocker(agent, signingEnabled)}
            onClick={() => setSub('issue')}
          >
            Issue credential
          </Button>
          <Button
            icon={<BranchesOutlined />}
            disabled={!!delegateBlocker(agent)}
            onClick={() => setSub('delegate')}
          >
            Delegate
          </Button>
          <Button
            danger
            icon={<StopOutlined />}
            disabled={!!revokeBlocker(agent)}
            onClick={() => setSub('revoke')}
          >
            Revoke
          </Button>
          <Button
            type="primary"
            danger
            icon={<ThunderboltOutlined />}
            disabled={!!killBlocker(agent)}
            onClick={() => setSub('kill')}
          >
            Kill switch
          </Button>
        </Space>
      )}
    </div>
  );

  return (
    <Modal
      open={!!row}
      onCancel={onClose}
      centered
      width={MODAL_WIDTH}
      title={
        <Space size={8} wrap>
          <span style={{ wordBreak: 'break-word' }}>{agent.displayName}</span>
          <AgentStatusTags agent={agent} />
        </Space>
      }
      footer={footer}
      styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {isOwnerless(agent) && (
          <Alert
            type="warning"
            showIcon
            message="No owner"
            description={
              <>
                The owner was{' '}
                {OWNERLESS_REASON[agent.ownerlessReason ?? 'offboarded'] ?? agent.ownerlessReason}{' '}
                on {formatDateTime(agent.ownerlessSince)}, so the agent gets no new credential.
                Credentials issued before keep working until a super-admin gives it a new owner or
                revokes it.
              </>
            }
          />
        )}
        {canFinish && (
          <Alert
            type="warning"
            showIcon
            message={
              pending.isError
                ? 'Could not check the delegated agents of this revoked agent.'
                : `${stillActive} delegated ${stillActive === 1 ? 'agent is' : 'agents are'} still active: the ${finishAction === 'kill' ? 'kill switch' : 'revoke'} did not reach ${stillActive === 1 ? 'it' : 'them'}.`
            }
            description="Finish cascade calls it again: the API revokes the delegated agents still active and leaves every agent already ended as it is."
          />
        )}
        {detail.isError && (
          <Alert
            type="warning"
            showIcon
            message="Could not reload this agent; showing it as listed."
          />
        )}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Agent id">
            <Text code copyable style={{ wordBreak: 'break-all' }}>
              {agent.agentId}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="Kind">{KIND_LABEL[agent.kind] ?? agent.kind}</Descriptions.Item>
          <Descriptions.Item label="Owner">
            <Link to={identityPath(agent.owner.identityId)}>{agent.owner.email}</Link>
          </Descriptions.Item>
          <Descriptions.Item label="Scope">
            <Space size={[4, 4]} wrap>
              {agent.scope.map((s) => (
                <Tag key={s}>{s}</Tag>
              ))}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Risk tier">
            <Tag color={RISK_TAG[agent.riskTier]}>
              {RISK_LABEL[agent.riskTier] ?? agent.riskTier}
            </Tag>
          </Descriptions.Item>
          {agent.parentAgentId && (
            <Descriptions.Item label="Delegated from">
              <Text code>{agent.parentAgentId}</Text>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="Expires">{formatDateTime(agent.expiresAt)}</Descriptions.Item>
          <Descriptions.Item label="Created">
            {formatDateTime(agent.createdAt)} by {agent.createdBy}
          </Descriptions.Item>
          <Descriptions.Item label="Last credential">
            {agent.lastRotatedAt ? (
              <>
                {formatDateTime(agent.lastRotatedAt)}
                {agent.credentialFingerprint && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    Signature fingerprint {agent.credentialFingerprint.slice(0, 16)}…
                  </Text>
                )}
              </>
            ) : (
              'None issued'
            )}
          </Descriptions.Item>
          {agent.revokedAt && (
            <Descriptions.Item label="Revoked">
              {formatDateTime(agent.revokedAt)} by {agent.revokedBy}
              {agent.revocationReason && (
                <Text type="secondary" style={{ display: 'block', wordBreak: 'break-word' }}>
                  {agent.revocationReason}
                </Text>
              )}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Space>
      {sub === 'delegate' && <AgentFormModal parent={agent} onClose={() => setSub(null)} />}
      {sub === 'issue' && <IssueCredentialModal agent={agent} onClose={() => setSub(null)} />}
      {sub === 'owner' && <ChangeOwnerModal agent={agent} onClose={() => setSub(null)} />}
      {(sub === 'revoke' || sub === 'kill') && (
        <RevokeAgentModal agent={agent} action={sub} onClose={() => setSub(null)} />
      )}
    </Modal>
  );
};
