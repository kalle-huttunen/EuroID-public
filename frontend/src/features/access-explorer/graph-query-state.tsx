/**
 * What an explorer view shows instead of its data while the query loads or after it failed: a
 * skeleton, the graph not available (the API's 503), or another error with the API's message.
 */
import React from 'react';
import { Skeleton } from 'antd';
import { isGraphUnavailable } from '@api/access-explorer-api';
import { ErrorState } from '@shared/ErrorState';
import { GraphUnavailable } from './GraphStates';

interface QueryLike {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** Null when there is data to show. */
export function queryState(query: QueryLike, what: string): React.ReactNode {
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 5 }} aria-busy />;
  if (!query.isError) return null;
  if (isGraphUnavailable(query.error)) {
    return <GraphUnavailable error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <ErrorState
      title={`Could not load ${what}`}
      error={query.error}
      onRetry={() => void query.refetch()}
    />
  );
}
