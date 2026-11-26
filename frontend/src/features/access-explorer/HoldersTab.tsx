/**
 * Who holds an entitlement (GET /access-explorer/entitlement/:id/holders, viewer). The API lists
 * one holder per path; the table shows each identity once with its shortest way and how many ways
 * it has. Says when the API cut the answer and when the graph does not have the entitlement.
 */
import React, { useMemo } from 'react';
import { Alert, Button, Space, Table, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useEntitlementHolders } from '@api/access-explorer-api';
import { EmptyState } from '@shared/EmptyState';
import { PAGE_SIZES } from '@config/pagination';
import type { IEntitlementHolder, IEntitlementHolders, IGraphNode } from '../../interfaces';
import { identityPath } from '../users/identity-path';
import { entitlementDetail, grantText, identityText, pathSummary } from './access-explorer-labels';
import { NotInGraph } from './GraphStates';
import { queryState } from './graph-query-state';
import { EntitlementPicker } from './ExplorerPickers';

const { Text } = Typography;

interface HolderRow {
  identity: IGraphNode;
  shortest: IEntitlementHolder;
  ways: number;
}

function holderRows(answer: IEntitlementHolders): HolderRow[] {
  const byId = new Map<string, HolderRow>();
  for (const h of answer.holders) {
    const row = byId.get(h.identity.id);
    if (!row) byId.set(h.identity.id, { identity: h.identity, shortest: h, ways: 1 });
    else {
      row.ways += 1;
      if (h.pathDepth < row.shortest.pathDepth) row.shortest = h;
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.shortest.pathDepth - b.shortest.pathDepth ||
      identityText(a.identity).localeCompare(identityText(b.identity)),
  );
}

const HoldersView: React.FC<{
  answer: IEntitlementHolders;
  onShowIdentity: (identityId: string) => void;
}> = ({ answer, onShowIdentity }) => {
  const rows = useMemo(() => holderRows(answer), [answer]);
  const name = answer.entitlement?.label || answer.entitlementId;
  const detail = answer.entitlement ? entitlementDetail(answer.entitlement) : '';
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Text>
        <Text strong>{name}</Text>
        {detail && <Text type="secondary"> ({detail})</Text>}:{' '}
        {rows.length === 1 ? '1 identity holds it' : `${rows.length} identities hold it`}
      </Text>
      {answer.truncated && (
        <Alert
          type="warning"
          showIcon
          message={`The graph has more than ${answer.pathLimit} ways to this entitlement`}
          description={`The API returned the first ${answer.pathLimit}, so some holders may be missing.`}
        />
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="Nobody holds this entitlement in the graph"
          description="No identity reaches it, directly or through groups, in what the graph has."
        />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table<HolderRow>
            aria-label={`Holders of ${name}`}
            size="small"
            rowKey={(r) => r.identity.id}
            dataSource={rows}
            pagination={{ pageSize: PAGE_SIZES.MEDIUM, hideOnSinglePage: true }}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: 'Identity',
                key: 'identity',
                render: (_, r) => (
                  <Link to={identityPath(r.identity.id)}>{identityText(r.identity)}</Link>
                ),
              },
              {
                title: 'How it is reached',
                key: 'how',
                render: (_, r) =>
                  pathSummary({ nodes: r.shortest.pathNodes, depth: r.shortest.pathDepth }),
              },
              {
                title: 'Granted',
                key: 'grant',
                render: (_, r) => grantText(r.shortest.pathRelationships[0]),
              },
              { title: 'Ways', key: 'ways', render: (_, r) => r.ways },
              {
                title: 'Access graph',
                key: 'actions',
                render: (_, r) => (
                  <Button
                    size="small"
                    aria-label={`Show the access graph of ${identityText(r.identity)}`}
                    onClick={() => onShowIdentity(r.identity.id)}
                  >
                    Access graph
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}
    </Space>
  );
};

export const HoldersTab: React.FC<{
  entitlementId?: string;
  onEntitlement: (id: string | undefined) => void;
  onShowIdentity: (identityId: string) => void;
  onLoadGraph?: () => void;
}> = ({ entitlementId, onEntitlement, onShowIdentity, onLoadGraph }) => {
  const query = useEntitlementHolders(entitlementId);
  let body: React.ReactNode;
  if (!entitlementId) {
    body = (
      <EmptyState
        title="Choose an entitlement"
        description="Every identity that reaches it, directly or through groups."
      />
    );
  } else {
    body = queryState(query, 'the holders');
    if (!body && query.data) {
      body = query.data.entitlementFound ? (
        <HoldersView answer={query.data} onShowIdentity={onShowIdentity} />
      ) : (
        <NotInGraph what="entitlement" onLoadGraph={onLoadGraph} />
      );
    }
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <EntitlementPicker value={entitlementId} onChange={onEntitlement} />
      <div aria-busy={query.isFetching}>{body}</div>
    </Space>
  );
};
