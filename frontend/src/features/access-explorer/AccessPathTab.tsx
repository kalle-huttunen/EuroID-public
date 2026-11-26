/**
 * The shortest access path from an identity to an entitlement (GET /access-explorer/path, viewer):
 * each step with how it was granted where the graph knows. Without a path, says which end the
 * graph does not have, or that both are there and not connected.
 */
import React from 'react';
import { Alert, Space, Steps, Typography } from 'antd';
import { useAccessPath } from '@api/access-explorer-api';
import { EmptyState } from '@shared/EmptyState';
import type { IAccessPath, IAccessPathResult } from '../../interfaces';
import {
  NOT_IN_GRAPH_HINT,
  TYPE_LABEL,
  entitlementDetail,
  grantText,
  identityText,
} from './access-explorer-labels';
import { queryState } from './graph-query-state';
import { EntitlementPicker, IdentityPicker } from './ExplorerPickers';

const { Text } = Typography;

const PathSteps: React.FC<{ path: IAccessPath }> = ({ path }) => (
  <Steps
    direction="vertical"
    size="small"
    current={path.nodes.length}
    items={path.nodes.map((node, i) => {
      const into = i > 0 ? path.relationships[i - 1] : undefined;
      const title = node.type === 'Identity' ? identityText(node) : node.label || node.id;
      const detail = node.type === 'Identity' ? '' : entitlementDetail(node);
      return {
        title,
        description: (
          <Space direction="vertical" size={0}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {[TYPE_LABEL[node.type], detail].filter(Boolean).join(', ')}
            </Text>
            {into && <Text style={{ fontSize: 12 }}>{grantText(into)}</Text>}
          </Space>
        ),
      };
    })}
  />
);

function notFound(answer: IAccessPathResult): { message: string; description?: string } {
  if (!answer.identityFound || !answer.entitlementFound) {
    const missing = [
      !answer.identityFound && 'the identity',
      !answer.entitlementFound && 'the entitlement',
    ].filter(Boolean);
    return {
      message: `The access graph does not have ${missing.join(' or ')}`,
      description: NOT_IN_GRAPH_HINT,
    };
  }
  return {
    message: 'No access path',
    description:
      'The identity does not reach this entitlement in the graph, directly or through groups (up to 10 hops).',
  };
}

export const AccessPathTab: React.FC<{
  identityId?: string;
  entitlementId?: string;
  onIdentity: (id: string | undefined) => void;
  onEntitlement: (id: string | undefined) => void;
}> = ({ identityId, entitlementId, onIdentity, onEntitlement }) => {
  const query = useAccessPath(identityId, entitlementId);
  let body: React.ReactNode;
  if (!identityId || !entitlementId) {
    body = (
      <EmptyState
        title="Choose an identity and an entitlement"
        description="The shortest way from the identity to the entitlement, step by step."
      />
    );
  } else {
    body = queryState(query, 'the access path');
    if (!body && query.data) {
      const answer = query.data;
      if (answer.found && answer.path) {
        body = (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text>
              {answer.path.depth === 1
                ? 'Direct access, one step:'
                : `${answer.path.depth} steps, through groups:`}
            </Text>
            <PathSteps path={answer.path} />
          </Space>
        );
      } else {
        body = <Alert type="info" showIcon role="status" {...notFound(answer)} />;
      }
    }
  }
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <IdentityPicker value={identityId} onChange={onIdentity} />
      <EntitlementPicker value={entitlementId} onChange={onEntitlement} />
      <div aria-busy={query.isFetching}>{body}</div>
    </Space>
  );
};
