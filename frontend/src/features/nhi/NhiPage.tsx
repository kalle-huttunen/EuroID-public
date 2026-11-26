/**
 * Non-human identities (`/nhi`, every role, like GET /nhi): service accounts, workloads, AI
 * agents and bots, each with a human owner, a scope and an expiry of at most 90 days. Everyone
 * filters the list (also to the agents whose owner left) and reads an agent (AgentDetailModal). A super-admin also creates agents,
 * delegates, revokes, engages the kill switch and issues short-lived credentials, and sees
 * whether credential signing is configured (GET /nhi/_/credential-signing-status).
 */
import React, { useState } from 'react';
import { Button, Card, Select, Skeleton, Space, Tag, Tooltip } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { NHI_PAGE_SIZE, nhiKeys, useAgents, useCredentialSigningStatus } from '@api/nhi-api';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { EmptyState } from '@shared/EmptyState';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import type {
  AgentKind,
  AgentRiskTier,
  AgentStatus,
  IAgentFilter,
  IAgentIdentity,
} from '../../interfaces';
import { AgentDetailModal } from './AgentDetailModal';
import { AgentFormModal } from './AgentFormModal';
import { AgentTable } from './AgentTable';
import { OwnerPicker } from './OwnerPicker';
import { KINDS, KIND_LABEL, RISK_LABEL, RISK_TIERS, STATUSES, STATUS_LABEL } from './nhi-labels';

const SigningStatus: React.FC<{ enabled?: boolean; failed: boolean }> = ({ enabled, failed }) => {
  if (failed) return <Tag>Signing status unknown</Tag>;
  if (enabled === undefined) return null;
  return enabled ? (
    <Tag color="success">Credential signing configured</Tag>
  ) : (
    <Tooltip title="Set NHI_SIGNING_PRIVATE_KEY (an Ed25519 private key in PEM) on the API to issue credentials.">
      <Tag color="warning">Credential signing not configured</Tag>
    </Tooltip>
  );
};

export const NhiPage: React.FC = () => {
  const qc = useQueryClient();
  const isSuperAdmin = usePermission('super-admin');
  const [filter, setFilter] = useState<IAgentFilter>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<IAgentIdentity | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useAgents(filter, page);
  const signing = useCredentialSigningStatus(isSuperAdmin);

  const applyFilter = (next: IAgentFilter) => {
    setFilter(next);
    setPage(1);
  };
  const filtered = !!(
    filter.kind ||
    filter.status ||
    filter.riskTier ||
    filter.ownerIdentityId ||
    filter.ownerless
  );
  const rows = list.data?.data ?? [];

  let body: React.ReactNode;
  if (list.isLoading) {
    body = <Skeleton active paragraph={{ rows: 6 }} />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title="Could not load the non-human identities"
        error={list.error}
        onRetry={() => list.refetch()}
      />
    );
  } else if (!rows.length) {
    body = (
      <EmptyState
        title={filtered ? 'No agent matches these filters' : 'No non-human identities yet'}
        description={
          filtered
            ? undefined
            : 'Service accounts, workloads, AI agents and bots appear here once a super-admin creates them.'
        }
        action={
          filtered
            ? { label: 'Clear filters', type: 'default', onClick: () => applyFilter({}) }
            : isSuperAdmin
              ? {
                  label: 'Create the first agent',
                  icon: <PlusOutlined />,
                  onClick: () => setCreating(true),
                }
              : undefined
        }
      />
    );
  } else {
    body = (
      <AgentTable
        rows={rows}
        total={list.data?.total ?? rows.length}
        page={page}
        pageSize={NHI_PAGE_SIZE}
        onPage={setPage}
        onOpen={setSelected}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Non-human identities"
        subtitle="Service accounts, workloads, AI agents and bots. Each has a human owner, a scope and an expiry of at most 90 days; a delegated agent gets part of its parent's scope, never more."
        actions={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => qc.invalidateQueries({ queryKey: nhiKeys.all })}
            >
              Refresh
            </Button>
            {isSuperAdmin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                New agent
              </Button>
            )}
          </Space>
        }
      />
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap size="middle">
            <Select<AgentKind>
              aria-label="Kind"
              placeholder="Any kind"
              allowClear
              value={filter.kind}
              onChange={(kind) => applyFilter({ ...filter, kind })}
              options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              style={{ minWidth: 160 }}
            />
            <Select<AgentStatus>
              aria-label="Status"
              placeholder="Any status"
              allowClear
              value={filter.status}
              onChange={(status) => applyFilter({ ...filter, status })}
              options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              style={{ minWidth: 150 }}
            />
            <Select<AgentRiskTier>
              aria-label="Risk tier"
              placeholder="Any risk tier"
              allowClear
              value={filter.riskTier}
              onChange={(riskTier) => applyFilter({ ...filter, riskTier })}
              options={RISK_TIERS.map((r) => ({ value: r, label: RISK_LABEL[r] }))}
              style={{ minWidth: 150 }}
            />
            <Select<'ownerless'>
              aria-label="Ownership"
              placeholder="Any ownership"
              allowClear
              value={filter.ownerless ? 'ownerless' : undefined}
              onChange={(v) =>
                applyFilter({ ...filter, ownerless: v === 'ownerless' || undefined })
              }
              options={[{ value: 'ownerless', label: 'Ownerless' }]}
              style={{ minWidth: 160 }}
            />
            <div style={{ width: 280, maxWidth: '100%' }}>
              <OwnerPicker
                ariaLabel="Owner"
                placeholder="Any owner: search by name or email"
                value={filter.ownerIdentityId}
                onChange={(ownerIdentityId) => applyFilter({ ...filter, ownerIdentityId })}
              />
            </div>
          </Space>
          {isSuperAdmin && (
            <SigningStatus enabled={signing.data?.enabled} failed={signing.isError} />
          )}
        </Space>
      </Card>
      <Card size="small" role="region" aria-label="Agents" aria-busy={list.isFetching}>
        {body}
      </Card>
      {selected && (
        <AgentDetailModal
          row={selected}
          signingEnabled={signing.data?.enabled}
          onClose={() => setSelected(null)}
        />
      )}
      {creating && <AgentFormModal onClose={() => setCreating(false)} />}
    </PageContainer>
  );
};
