/**
 * An identity's access graph (GET /access-explorer/identity/:id/graph, viewer): the canvas, at
 * most CANVAS_NODE_LIMIT nodes besides the identity, and a table of everything the identity
 * reaches with the shortest way there and how it was granted where the graph knows. Says when the
 * API cut the answer, when the canvas left nodes out, and that accounts are not in the graph.
 */
import React, { useMemo } from 'react';
import { Alert, Button, Space, Table, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useIdentityAccessGraph } from '@api/access-explorer-api';
import { EmptyState } from '@shared/EmptyState';
import { PAGE_SIZES } from '@config/pagination';
import type { IIdentityAccessGraph } from '../../interfaces';
import { AccessGraphCanvas } from './AccessGraphCanvas';
import { accessRows, canvasLayout, type AccessRow } from './access-graph';
import {
  NO_ACCOUNTS_NOTE,
  entitlementDetail,
  grantText,
  identityText,
  pathSummary,
} from './access-explorer-labels';
import { NotInGraph } from './GraphStates';
import { queryState } from './graph-query-state';
import { IdentityPicker } from './ExplorerPickers';

const { Text } = Typography;

const AccessGraphView: React.FC<{
  graph: IIdentityAccessGraph;
  onShowHolders: (entitlementId: string) => void;
}> = ({ graph, onShowHolders }) => {
  const rows = useMemo(() => accessRows(graph), [graph]);
  const layout = useMemo(() => canvasLayout(graph, rows), [graph, rows]);
  const root = graph.nodes.find((n) => n.id === graph.identityId);
  const who = root ? identityText(root) : graph.identityId;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No access in the graph for this identity"
        description="The graph links access when provisioning completes and when a super-admin loads it from MongoDB. Access assigned only in a target system is not in it."
      />
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {graph.truncated && (
        <Alert
          type="warning"
          showIcon
          message={`The graph has more than ${graph.pathLimit} access paths for this identity`}
          description={`The API returned the first ${graph.pathLimit}, so some entitlements below may be missing.`}
        />
      )}
      <AccessGraphCanvas layout={layout} label={`Access graph of ${who}`} />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {layout.shown < layout.total
          ? `The canvas shows the ${layout.shown} nearest of ${layout.total} nodes; the table lists all ${layout.total}. `
          : ''}
        {NO_ACCOUNTS_NOTE}{' '}
        <Link to={`/identity/${encodeURIComponent(graph.identityId)}/map`}>Entitlement map</Link>
      </Text>
      <div style={{ overflowX: 'auto' }}>
        <Table<AccessRow>
          aria-label={`Access of ${who}`}
          size="small"
          rowKey={(r) => r.node.id}
          dataSource={rows}
          pagination={{ pageSize: PAGE_SIZES.MEDIUM, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'Entitlement',
              key: 'entitlement',
              render: (_, r) => (
                <Space direction="vertical" size={0}>
                  <Text strong>{r.node.label || r.node.id}</Text>
                  {r.node.label !== r.node.id && (
                    <Text type="secondary" code style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {r.node.id}
                    </Text>
                  )}
                </Space>
              ),
            },
            {
              title: 'System and type',
              key: 'detail',
              render: (_, r) => entitlementDetail(r.node) || r.node.type,
            },
            {
              title: 'How it is reached',
              key: 'how',
              render: (_, r) =>
                pathSummary({ nodes: [root ?? r.node, ...r.via, r.node], depth: r.depth }),
            },
            { title: 'Granted', key: 'grant', render: (_, r) => grantText(r.edge) },
            {
              title: 'Holders',
              key: 'actions',
              render: (_, r) =>
                r.node.type === 'Entitlement' ? (
                  <Button
                    size="small"
                    aria-label={`Show who holds ${r.node.label || r.node.id}`}
                    onClick={() => onShowHolders(r.node.id)}
                  >
                    Who holds it
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>
    </Space>
  );
};

export const IdentityAccessTab: React.FC<{
  identityId?: string;
  onIdentity: (id: string | undefined) => void;
  onShowHolders: (entitlementId: string) => void;
  onLoadGraph?: () => void;
}> = ({ identityId, onIdentity, onShowHolders, onLoadGraph }) => {
  const query = useIdentityAccessGraph(identityId);
  let body: React.ReactNode;
  if (!identityId) {
    body = (
      <EmptyState
        title="Choose an identity"
        description="Its entitlements, reached directly or through groups, and how each was granted."
      />
    );
  } else {
    body = queryState(query, 'the access graph');
    if (!body && query.data) {
      body = query.data.identityFound ? (
        <AccessGraphView graph={query.data} onShowHolders={onShowHolders} />
      ) : (
        <NotInGraph what="identity" onLoadGraph={onLoadGraph} />
      );
    }
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <IdentityPicker value={identityId} onChange={onIdentity} />
      <div aria-busy={query.isFetching}>{body}</div>
    </Space>
  );
};
