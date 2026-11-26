/**
 * Policy Suggestions — Intelligence Layer
 *
 * Shows policy suggestions with accept/dismiss flow.
 */

import React, { useState } from 'react';
import {
  Card,
  Row,
  Col,
  Button,
  Space,
  Typography,
  Tag,
  Select,
  Progress,
  App,
  Modal,
  Input,
  Empty,
  Skeleton,
  message,
  theme,
} from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  fetchPolicySuggestions,
  acceptSuggestion,
  dismissSuggestion,
  intelligenceKeys,
  type PolicySuggestion,
  type SuggestionType,
} from '@api/intelligence-api';
import { useSocket } from '@api/realtime';
import {
  PolicyDisplay,
  type PolicyDisplayInput,
} from '../../components/policy-engine/PolicyDisplay';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';

const { Text } = Typography;
const PAGE_SIZE = 20;

const SUGGESTION_TYPE_LABELS: Record<SuggestionType, string> = {
  BIRTHRIGHT_PATTERN: 'Birthright',
  ORPHAN_ENTITLEMENT: 'Orphan',
  REDUNDANT_POLICY: 'Redundant',
  COVERAGE_GAP: 'Coverage Gap',
};

const SUGGESTION_TYPE_COLORS: Record<SuggestionType, string> = {
  BIRTHRIGHT_PATTERN: 'green',
  ORPHAN_ENTITLEMENT: 'orange',
  REDUNDANT_POLICY: 'volcano',
  COVERAGE_GAP: 'blue',
};

function getConfidenceColor(conf: number): string {
  if (conf >= 80) return 'green';
  if (conf >= 60) return 'blue';
  if (conf >= 40) return 'orange';
  return 'default';
}

export const PolicySuggestions: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { status } = useSocket();
  // App.useApp's modal follows the app's theme; a static Modal.confirm renders outside it.
  const { modal } = App.useApp();
  const [filters, setFilters] = useState<{
    type?: SuggestionType;
    status?: string;
    confidenceMin?: number;
  }>({});
  const [page, setPage] = useState(0);
  // Accept and dismiss need policy-admin
  const canDecide = usePermission('policy-admin');
  const [dismissModalOpen, setDismissModalOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const suggestionsQuery = useQuery({
    queryKey: intelligenceKeys.suggestions({
      ...filters,
      page,
      limit: PAGE_SIZE,
    }),
    queryFn: () =>
      fetchPolicySuggestions({
        ...filters,
        page,
        limit: PAGE_SIZE,
      }),
  });
  const { data: suggestionsRes, isLoading } = suggestionsQuery;

  const acceptMutation = useMutation({
    mutationFn: acceptSuggestion,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.suggestionsPrefix() });
      message.success('Suggestion accepted. Draft policy created.');
      // The answer is the accepted suggestion; the draft policy is listed under Role-based rules.
      if (data?.resultingPolicyId) {
        navigate('/role-rules');
      }
    },
    // Not returned: React Query would keep the mutation pending until the toast closes
    onError: (e: unknown) => {
      message.error(`Failed to accept: ${apiErrorMessage(e, 'the request failed')}`);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => dismissSuggestion(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.suggestionsPrefix() });
      setDismissModalOpen(false);
      setDismissReason('');
      setDismissingId(null);
      message.success('Suggestion dismissed');
    },
    onError: (e: unknown) => {
      message.error(`Failed to dismiss: ${apiErrorMessage(e, 'the request failed')}`);
      setDismissingId(null);
    },
  });

  const suggestions = suggestionsRes?.data ?? [];
  const total = suggestionsRes?.total ?? 0;

  const handleAccept = (s: PolicySuggestion) => {
    modal.confirm({
      title: 'Accept & Create Draft Policy?',
      content: `This will create a draft policy based on "${s.title}". You will be taken to Role-based rules, where it is listed.`,
      onOk: () => acceptMutation.mutate(s.suggestionId),
    });
  };

  const handleDismiss = (id: string) => {
    setDismissingId(id);
    setDismissModalOpen(true);
  };

  const confirmDismiss = () => {
    if (!dismissingId) return;
    dismissMutation.mutate({ id: dismissingId, reason: dismissReason || undefined });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Policy suggestions"
        titleExtra={status === 'connected' ? <Tag color="success">Live</Tag> : null}
        subtitle="Policy recommendations derived from observed access patterns."
      />

      {/* Filter bar */}
      <Card style={{ marginBottom: 24 }}>
        <Space wrap>
          <Select
            placeholder="Type"
            allowClear
            style={{ width: 160 }}
            value={filters.type}
            onChange={(v) => setFilters((f) => ({ ...f, type: v }))}
          >
            {Object.entries(SUGGESTION_TYPE_LABELS).map(([k, v]) => (
              <Select.Option key={k} value={k}>
                {v}
              </Select.Option>
            ))}
          </Select>
          <Select
            placeholder="Status"
            allowClear
            style={{ width: 120 }}
            value={filters.status}
            onChange={(v) => setFilters((f) => ({ ...f, status: v }))}
          >
            <Select.Option value="pending">Pending</Select.Option>
            <Select.Option value="accepted">Accepted</Select.Option>
            <Select.Option value="dismissed">Dismissed</Select.Option>
            <Select.Option value="expired">Expired</Select.Option>
          </Select>
          <Select
            placeholder="Min Confidence"
            allowClear
            style={{ width: 140 }}
            value={filters.confidenceMin}
            onChange={(v) => setFilters((f) => ({ ...f, confidenceMin: v }))}
          >
            <Select.Option value={90}>90%+</Select.Option>
            <Select.Option value={70}>70%+</Select.Option>
            <Select.Option value={50}>50%+</Select.Option>
          </Select>
        </Space>
      </Card>

      {/* Suggestion cards */}
      {isLoading ? (
        <Skeleton active />
      ) : suggestionsQuery.isError ? (
        <ErrorState
          title="Suggestions could not be loaded"
          error={suggestionsQuery.error}
          onRetry={() => void suggestionsQuery.refetch()}
        />
      ) : suggestions.length === 0 ? (
        <Empty
          description="No suggestions yet. Run analysis to discover policy improvements."
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <Row gutter={[16, 16]}>
          {suggestions.map((s) => (
            <Col xs={24} md={12} lg={8} key={s.suggestionId}>
              <Card
                size="small"
                style={{ height: '100%' }}
                actions={
                  s.status === 'pending' && canDecide
                    ? [
                        <Button
                          key="accept"
                          type="primary"
                          icon={<CheckOutlined />}
                          onClick={() => handleAccept(s)}
                          loading={acceptMutation.isPending}
                        >
                          Accept & Create Draft
                        </Button>,
                        <Button
                          key="dismiss"
                          danger
                          icon={<CloseOutlined />}
                          onClick={() => handleDismiss(s.suggestionId)}
                        >
                          Dismiss
                        </Button>,
                      ]
                    : undefined
                }
              >
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <Tag color={SUGGESTION_TYPE_COLORS[s.type]}>{SUGGESTION_TYPE_LABELS[s.type]}</Tag>
                  <div>
                    <Text strong>{s.title}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {s.description}
                  </Text>
                  <Progress
                    percent={s.confidence}
                    size="small"
                    strokeColor={
                      getConfidenceColor(s.confidence) === 'green'
                        ? token.colorSuccess
                        : getConfidenceColor(s.confidence) === 'blue'
                          ? token.colorPrimary
                          : token.colorWarning
                    }
                  />
                  {s.evidence && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {s.evidence.matchingUsers} of {s.evidence.totalUsers} users (
                      {s.evidence.percentage}%) —{' '}
                      {s.evidence.affectedEntitlements?.slice(0, 2).join(', ')}
                      {s.evidence.affectedEntitlements && s.evidence.affectedEntitlements.length > 2
                        ? '...'
                        : ''}
                    </Text>
                  )}
                  <Tag color={s.status === 'pending' ? 'blue' : 'default'}>{s.status}</Tag>
                  {s.suggestedPolicy != null ? (
                    <PolicyDisplay
                      policy={
                        {
                          ...(s.suggestedPolicy as Record<string, unknown>),
                          rawJson: s.suggestedPolicy as Record<string, unknown>,
                        } as PolicyDisplayInput
                      }
                    />
                  ) : null}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {total > PAGE_SIZE && (
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Space>
            <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
            <Text>
              Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
            </Text>
            <Button
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </Space>
        </div>
      )}

      <Modal
        title="Dismiss suggestion"
        open={dismissModalOpen}
        onOk={confirmDismiss}
        onCancel={() => {
          setDismissModalOpen(false);
          setDismissReason('');
          setDismissingId(null);
        }}
        confirmLoading={dismissMutation.isPending}
      >
        <Input.TextArea
          placeholder="Reason (optional)"
          value={dismissReason}
          onChange={(e) => setDismissReason(e.target.value)}
          rows={3}
        />
      </Modal>
    </PageContainer>
  );
};
