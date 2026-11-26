/**
 * Confirmation of a revoke (POST /nhi/:agentId/revoke) or the kill switch (POST .../kill),
 * super-admin. Before the confirm button it shows what the action reaches: the API's dry run of
 * the same call (?dryRun=true), which walks the cascade the real call walks (every delegated agent
 * stored as active, recursively) and changes nothing. Both need a reason; the kill switch, which
 * is permanent, also needs the agent id typed. If the preview cannot load, the action stays
 * available with a warning: an emergency stop must not wait on a read. The kill switch on an
 * agent already revoked keeps its first revocation and still reaches its delegated agents.
 * The same call on an agent it already ended (a revoke on a revoked agent, the kill switch on a
 * killed one) finishes a cascade that stopped part way: only the delegated agents still active
 * change.
 */
import React, { useState } from 'react';
import { Alert, App, Button, Input, Modal, Skeleton, Space, Typography } from 'antd';
import { StopOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useEndAgent, useEndAgentPreview, type EndAction } from '@api/nhi-api';
import type { IAgentIdentity } from '../../interfaces';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { KIND_LABEL, NOT_RECALLED_NOTE } from './nhi-labels';

const { Paragraph, Text } = Typography;

const MODAL_WIDTH = 640;

export type { EndAction };

/** The call ends no more than the cascade: the agent itself is already ended this way. */
const finishesCascade = (agent: IAgentIdentity, action: EndAction) =>
  agent.status === 'revoked' && (action === 'revoke' || agent.killSwitchEngaged);

const Reached: React.FC<{ agent: IAgentIdentity; action: EndAction }> = ({ agent, action }) => {
  const preview = useEndAgentPreview(agent.agentId, action);
  if (preview.isLoading) return <Skeleton active paragraph={{ rows: 2 }} />;
  if (preview.isError || !preview.data) {
    return (
      <Alert
        type="warning"
        showIcon
        message={`Could not load the delegated agents: ${apiErrorMessage(preview.error, 'the request failed')}`}
        description="The API revokes every active delegated agent anyway."
        action={
          <Button size="small" onClick={() => preview.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!preview.data.changes) {
    return (
      <Paragraph style={{ marginBottom: 0 }}>
        The API would change nothing: <Text code>{agent.agentId}</Text> is already revoked
        {action === 'kill' ? ' with the kill switch engaged' : ''}.
      </Paragraph>
    );
  }
  const { reached } = preview.data;
  const switchNote = action === 'kill' ? ', with the kill switch engaged' : '';
  return (
    <div>
      {finishesCascade(agent, action) && (
        <Paragraph style={{ marginBottom: 8 }}>
          <Text code>{agent.agentId}</Text> is already revoked{switchNote} and stays as it is. The
          call revokes the {reached.length} delegated {reached.length === 1 ? 'agent' : 'agents'}{' '}
          still active{switchNote}:
        </Paragraph>
      )}
      {action === 'kill' && agent.status === 'revoked' && !agent.killSwitchEngaged && (
        <Paragraph style={{ marginBottom: 8 }}>
          <Text code>{agent.agentId}</Text> is already revoked: it keeps its first revocation (time,
          by whom and reason) and gets the kill switch, a critical audit entry and the kill signal.
        </Paragraph>
      )}
      <Paragraph style={{ marginBottom: 8 }} hidden={finishesCascade(agent, action)}>
        {reached.length ? (
          <>
            Reaches <Text code>{agent.agentId}</Text> and {reached.length} delegated{' '}
            {reached.length === 1 ? 'agent' : 'agents'}, each revoked
            {action === 'kill' ? ' with the kill switch engaged' : ''}:
          </>
        ) : (
          <>
            Reaches <Text code>{agent.agentId}</Text> only: it has no active delegated agents.
          </>
        )}
      </Paragraph>
      {reached.length > 0 && (
        <ul
          aria-label="Agents reached"
          style={{ margin: 0, paddingInlineStart: 20, maxHeight: 200, overflowY: 'auto' }}
        >
          {reached.map((a) => (
            <li key={a.agentId} style={{ wordBreak: 'break-word' }}>
              <Text code>{a.agentId}</Text> {a.displayName} ({KIND_LABEL[a.kind] ?? a.kind}),
              delegated by <Text code>{a.parentAgentId}</Text>, owner {a.owner.email}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const RevokeAgentModal: React.FC<{
  agent: IAgentIdentity;
  action: EndAction;
  onClose: () => void;
}> = ({ agent, action, onClose }) => {
  const { message } = App.useApp();
  const end = useEndAgent(action);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const kill = action === 'kill';
  const ready = reason.trim().length > 0 && (!kill || typed.trim() === agent.agentId);
  const revoked = agent.status === 'revoked';
  const finishing = finishesCascade(agent, action);

  const confirm = async () => {
    try {
      const after = await end.mutateAsync({ agentId: agent.agentId, reason: reason.trim() });
      if (kill && !after.killSwitchEngaged) {
        message.warning(`The API did not engage the kill switch on "${agent.agentId}".`);
      } else {
        message.success(
          finishing
            ? `Cascade of "${agent.agentId}" finished`
            : kill
              ? `Kill switch engaged on "${agent.agentId}"`
              : `Agent "${agent.agentId}" revoked`,
        );
      }
      onClose();
    } catch {
      // The error is shown in the dialog (end.error), which stays open.
    }
  };

  const footer = (
    <Space wrap style={{ justifyContent: 'flex-end' }}>
      <Button onClick={onClose} disabled={end.isPending}>
        Cancel
      </Button>
      <Button
        type="primary"
        danger
        icon={kill ? <ThunderboltOutlined /> : <StopOutlined />}
        disabled={!ready}
        loading={end.isPending}
        onClick={confirm}
      >
        {finishing
          ? kill
            ? 'Engage kill switch on delegated agents'
            : 'Revoke delegated agents'
          : kill
            ? 'Engage kill switch'
            : 'Revoke agent'}
      </Button>
    </Space>
  );

  return (
    <Modal
      open
      centered
      width={MODAL_WIDTH}
      title={
        finishing
          ? `Finish the cascade of "${agent.agentId}"?`
          : kill
            ? `Engage the kill switch on "${agent.agentId}"?`
            : `Revoke "${agent.agentId}"?`
      }
      footer={footer}
      onCancel={() => !end.isPending && onClose()}
      maskClosable={false}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="error"
          showIcon
          message={
            kill ? 'The kill switch is permanent. It cannot be undone.' : 'This cannot be undone.'
          }
          description={
            kill
              ? 'The agent is revoked for good and can never get a credential again. The audit log records it as critical.'
              : 'A revoked agent cannot be reactivated, delegate or get a credential.'
          }
        />
        <Reached agent={agent} action={action} />
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          <li>
            The audit log gets a {kill ? 'critical' : 'warning'} entry for each agent, and EuroID
            emits <Text code>{kill ? 'nhi.kill_switch_engaged' : 'nhi.revoked'}</Text>, which
            matching webhook subscriptions receive.
          </li>
          <li>{NOT_RECALLED_NOTE}</li>
        </ul>
        <div>
          <Text strong>Reason</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            {revoked
              ? 'Recorded in the audit log and the kill signal (the agent keeps the reason of its revocation); delegated agents get it after "cascade:".'
              : 'Recorded with the agent and in the audit log; delegated agents get it after "cascade:".'}
          </Text>
          <Input.TextArea
            aria-label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoSize={{ minRows: 2, maxRows: 4 }}
            disabled={end.isPending}
          />
        </div>
        {kill && (
          <div>
            <Paragraph style={{ marginBottom: 8 }}>
              Type <Text code>{agent.agentId}</Text> to engage the kill switch.
            </Paragraph>
            <Input
              aria-label="Agent id to confirm"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={end.isPending}
            />
          </div>
        )}
        {end.isError && (
          <Alert
            type="error"
            showIcon
            message={`${kill ? 'Kill switch' : 'Revoke'} failed: ${apiErrorMessage(end.error, 'the request failed')}`}
          />
        )}
      </Space>
    </Modal>
  );
};
