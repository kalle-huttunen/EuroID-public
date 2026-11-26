/**
 * One page of agents as a table: name and id (and the agent it was delegated from), kind, owner
 * (linked to the person's identity page), scope, status as the API returns it, risk tier and
 * expiry. Details opens the agent's modal. Paging is the server's (GET /nhi page and total).
 */
import React from 'react';
import { Button, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import type { IAgentIdentity } from '../../interfaces';
import { identityPath } from '../users/identity-path';
import {
  KIND_LABEL,
  RISK_LABEL,
  RISK_TAG,
  STATUS_LABEL,
  STATUS_TAG,
  formatDateTime,
  isOwnerless,
} from './nhi-labels';

const { Text } = Typography;

/**
 * The Agent column has no width: with the fixed layout it takes what the other columns leave.
 * The table is at least that much wider than their widths, so below it (phones) the table
 * scrolls sideways inside its card instead of squeezing the names; at 1440 px it fits.
 */
const AGENT_MIN_WIDTH = 220;
/** Scope entries shown in a row; the rest are counted, all of them in the tooltip and details. */
const SCOPE_SHOWN = 2;

/** Status as stored, plus the kill switch when it is engaged. */
export const AgentStatusTags: React.FC<{ agent: IAgentIdentity }> = ({ agent }) => (
  <Space size={[4, 4]} wrap>
    <Tag color={STATUS_TAG[agent.status]}>{STATUS_LABEL[agent.status] ?? agent.status}</Tag>
    {agent.killSwitchEngaged && <Tag color="error">Kill switch</Tag>}
    {isOwnerless(agent) && <Tag color="warning">Ownerless</Tag>}
  </Space>
);

export const AgentTable: React.FC<{
  rows: IAgentIdentity[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onOpen: (agent: IAgentIdentity) => void;
}> = ({ rows, total, page, pageSize, onPage, onOpen }) => {
  const columns: ColumnsType<IAgentIdentity> = [
    {
      title: 'Agent',
      key: 'agent',
      render: (_: unknown, a) => (
        <div style={{ minWidth: 0, wordBreak: 'break-word' }}>
          <Text strong>{a.displayName}</Text>
          <Text code style={{ display: 'block', fontSize: 12 }}>
            {a.agentId}
          </Text>
          {a.parentAgentId && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Delegated from <Text code>{a.parentAgentId}</Text>
            </Text>
          )}
        </div>
      ),
    },
    {
      title: 'Kind',
      dataIndex: 'kind',
      key: 'kind',
      width: 120,
      render: (kind: IAgentIdentity['kind']) => KIND_LABEL[kind] ?? kind,
    },
    {
      title: 'Owner',
      key: 'owner',
      width: 170,
      ellipsis: { showTitle: false },
      render: (_: unknown, a) => (
        <Tooltip title={a.owner.email}>
          <Link to={identityPath(a.owner.identityId)} aria-label={`Open the owner of ${a.agentId}`}>
            {a.owner.email}
          </Link>
        </Tooltip>
      ),
    },
    {
      title: 'Scope',
      key: 'scope',
      width: 160,
      render: (_: unknown, a) => (
        <Tooltip title={a.scope.join(', ')}>
          <Space size={[4, 4]} wrap>
            {a.scope.slice(0, SCOPE_SHOWN).map((s) => (
              <Tag key={s} style={{ marginInlineEnd: 0 }}>
                {s}
              </Tag>
            ))}
            {a.scope.length > SCOPE_SHOWN && (
              <Text type="secondary">+{a.scope.length - SCOPE_SHOWN}</Text>
            )}
          </Space>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_: unknown, a) => <AgentStatusTags agent={a} />,
    },
    {
      title: 'Risk',
      dataIndex: 'riskTier',
      key: 'riskTier',
      width: 90,
      render: (tier: IAgentIdentity['riskTier']) => (
        <Tag color={RISK_TAG[tier]}>{RISK_LABEL[tier] ?? tier}</Tag>
      ),
    },
    {
      title: 'Expires',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 140,
      render: (iso: string) => formatDateTime(iso),
    },
    {
      title: '',
      key: 'open',
      width: 84,
      render: (_: unknown, a) => (
        <Button size="small" onClick={() => onOpen(a)} aria-label={`Open agent ${a.agentId}`}>
          Details
        </Button>
      ),
    },
  ];
  const minWidth =
    AGENT_MIN_WIDTH +
    columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);

  return (
    <Table<IAgentIdentity>
      size="small"
      rowKey="_id"
      aria-label="Non-human identities"
      columns={columns}
      dataSource={rows}
      tableLayout="fixed"
      scroll={{ x: minWidth }}
      pagination={
        total > pageSize
          ? { current: page, pageSize, total, showSizeChanger: false, onChange: onPage }
          : false
      }
    />
  );
};
