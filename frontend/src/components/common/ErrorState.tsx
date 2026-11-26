/**
 * Reusable error state for failed queries: what failed, why (if known), Retry.
 * Same shape as the inline Result used by AuditDashboard / ReconciliationDashboard.
 */
import React from 'react';
import { Result, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';

interface ErrorStateProps {
  title: string;
  /** Error from the query; its message is shown when available. */
  error?: unknown;
  /** Fallback description when the error has no message. */
  description?: string;
  onRetry?: () => void;
  compact?: boolean;
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'object' && error !== null) {
    const resp = (error as { response?: { data?: { message?: unknown } } }).response;
    const apiMessage = resp?.data?.message;
    if (typeof apiMessage === 'string' && apiMessage) return apiMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return undefined;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  error,
  description = 'Check your connection and try again.',
  onRetry,
  compact,
}) => (
  <div role="alert">
    <Result
      status="warning"
      title={title}
      subTitle={errorMessage(error) ?? description}
      style={compact ? { padding: '24px 16px' } : undefined}
      extra={
        onRetry ? (
          <Button icon={<ReloadOutlined />} onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  </div>
);
