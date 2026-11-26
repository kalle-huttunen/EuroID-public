/**
 * The states every explorer view shares: the graph not available (the API's 503, with its message
 * and how the graph is filled) and a node the graph does not have. queryState (graph-query-state)
 * picks between loading, the 503 and another error.
 */
import React from 'react';
import { Button, Result, Typography } from 'antd';
import { CloudSyncOutlined, ReloadOutlined } from '@ant-design/icons';
import { EmptyState } from '@shared/EmptyState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { HOW_THE_GRAPH_IS_FILLED, NOT_IN_GRAPH_HINT } from './access-explorer-labels';

const { Paragraph } = Typography;

export const GraphUnavailable: React.FC<{ error: unknown; onRetry: () => void }> = ({
  error,
  onRetry,
}) => (
  <div role="alert">
    <Result
      status="warning"
      title="The access graph is not available"
      subTitle={apiErrorMessage(error, 'The API answered that the graph store is not available.')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={onRetry}>
          Retry
        </Button>
      }
    >
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {HOW_THE_GRAPH_IS_FILLED}
      </Paragraph>
    </Result>
  </div>
);

/** The graph has no node for the identity or entitlement: not the same as no access. */
export const NotInGraph: React.FC<{ what: string; onLoadGraph?: () => void }> = ({
  what,
  onLoadGraph,
}) => (
  <EmptyState
    title={`This ${what} is not in the access graph`}
    description={NOT_IN_GRAPH_HINT}
    action={
      onLoadGraph
        ? { label: 'Load graph from MongoDB', icon: <CloudSyncOutlined />, onClick: onLoadGraph }
        : undefined
    }
  />
);
