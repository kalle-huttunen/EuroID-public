/**
 * Uncorrelated Queue — dashboard for manually linking orphaned HR records to target identities.
 * Brownfield deployments: when automatic correlation fails (no match or ambiguous), admins link here.
 * [Link] opens the record and its candidates in a centered modal (LinkModal).
 * An identity with an account in a target cannot be linked until it is deleted (its offboarding
 * removes the accounts); it then stays here, tagged "Offboarded, ready to link" (`offboarded`).
 */

import React, { useState, useCallback } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Progress,
  Modal,
  message,
  Skeleton,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, LinkOutlined, UserAddOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { IUncorrelatedIdentity, IScoredCandidate } from '../../interfaces';
import { EmptyState } from '../../components/common/EmptyState';
import { PageContainer, PageHeader } from '@shared/PageHeader';

const { Text } = Typography;

// ── API ─────────────────────────────────────────────────────────────────

async function fetchUncorrelated(): Promise<IUncorrelatedIdentity[]> {
  const { data } = await axiosInstance.get<IUncorrelatedIdentity[]>(
    `${API_BASE}/identity/uncorrelated`,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchUncorrelatedCount(): Promise<number> {
  const { data } = await axiosInstance.get<{ count: number }>(
    `${API_BASE}/identity/uncorrelated/count`,
  );
  return data?.count ?? 0;
}

async function fetchCandidates(identityId: string): Promise<IScoredCandidate[]> {
  const { data } = await axiosInstance.get<{ candidates: IScoredCandidate[] }>(
    `${API_BASE}/identity/${identityId}/candidates`,
  );
  return data?.candidates ?? [];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function displayName(identity: IUncorrelatedIdentity): string {
  const first = identity.firstName || '';
  const last = identity.lastName || '';
  return [first, last].filter(Boolean).join(' ') || identity.email || identity._id;
}

function primarySource(identity: IUncorrelatedIdentity): string {
  const sources = identity.sources ?? [];
  const hr = sources.find((s) =>
    ['workday', 'bamboohr', 'hr-feed', 'sap', 'oracle'].some((h) =>
      (s.sourceName || '').toLowerCase().includes(h),
    ),
  );
  return hr?.sourceName ?? sources[0]?.sourceName ?? '—';
}

// ── Link Modal ───────────────────────────────────────────────────────────

/** Two columns (HR record, candidates) side by side; they stack when there is no room for both. */
const LINK_MODAL_WIDTH = 880;
/** A flex gap instead of a Row gutter, whose negative margins made the body scroll sideways. */
const LINK_COLUMNS: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '16px 24px' };
const LINK_COLUMN: React.CSSProperties = { flex: '1 1 320px', minWidth: 0 };

interface LinkModalProps {
  open: boolean;
  identity: IUncorrelatedIdentity | null;
  candidates: IScoredCandidate[];
  loadingCandidates: boolean;
  onLink: (targetIdentityId: string) => Promise<void>;
  onCreateStandalone: () => Promise<void>;
  /** Closes the modal only: the record stays in the queue (there is no "ignored" state). */
  onClose: () => void;
}

const LinkModal: React.FC<LinkModalProps> = ({
  open,
  identity,
  candidates,
  loadingCandidates,
  onLink,
  onCreateStandalone,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [linking, setLinking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ target: IScoredCandidate } | null>(null);

  const handleLinkClick = (candidate: IScoredCandidate) => {
    setConfirmModal({ target: candidate });
  };

  const handleConfirmLink = async () => {
    if (!confirmModal) return;
    setLinking(confirmModal.target.identityId);
    try {
      await onLink(confirmModal.target.identityId);
      setConfirmModal(null);
      onClose();
    } finally {
      setLinking(null);
    }
  };

  const handleCreateStandalone = async () => {
    setCreating(true);
    try {
      await onCreateStandalone();
      onClose();
    } finally {
      setCreating(false);
    }
  };

  if (!identity) return null;

  const hrRecord =
    identity.sources?.[0]?.rawData ?? (identity as unknown as Record<string, unknown>);

  return (
    <>
      <Modal
        title={`Link Identity: ${displayName(identity)}`}
        width={LINK_MODAL_WIDTH}
        open={open}
        onCancel={onClose}
        footer={
          <Space wrap>
            <Button icon={<UserAddOutlined />} onClick={handleCreateStandalone} loading={creating}>
              {identity.offboarded ? 'Keep Separate' : 'Create as New Person'}
            </Button>
            <Button onClick={onClose}>Close</Button>
          </Space>
        }
        styles={{ body: { maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' } }}
      >
        <div style={LINK_COLUMNS}>
          <div style={LINK_COLUMN}>
            <Card size="small" title="HR Record">
              <Space direction="vertical" style={{ width: '100%' }}>
                <div>
                  <Text type="secondary">Source: </Text>
                  <Text strong>{primarySource(identity)}</Text>
                </div>
                <div>
                  <Text type="secondary">Name: </Text>
                  <Text>{displayName(identity)}</Text>
                </div>
                <div>
                  <Text type="secondary">Dept: </Text>
                  <Text>{identity.departmentName ?? (hrRecord?.department as string) ?? '—'}</Text>
                </div>
                <div>
                  <Text type="secondary">Title: </Text>
                  <Text>{identity.jobTitle ?? (hrRecord?.jobTitle as string) ?? '—'}</Text>
                </div>
                <div>
                  <Text type="secondary">Employee #: </Text>
                  <Text>
                    {identity.employeeNumber ?? (hrRecord?.employeeNumber as string) ?? '—'}
                  </Text>
                </div>
                <div>
                  <Text type="secondary">Email: </Text>
                  <Text>{identity.email ?? (hrRecord?.email as string) ?? '—'}</Text>
                </div>
                {identity.offboarded && (
                  <Text type="secondary">
                    Offboarded: its accounts are removed. Link adds its HR records to the identity
                    you choose; Keep Separate takes it out of the queue.
                  </Text>
                )}
              </Space>
            </Card>
          </div>
          <div style={LINK_COLUMN}>
            <Card size="small" title="Candidates">
              {loadingCandidates ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : candidates.length === 0 ? (
                <EmptyState
                  title="No candidates found"
                  description="Try broadening the search or create as a new person."
                />
              ) : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {candidates.map((c) => (
                    <Card
                      key={c.identityId}
                      size="small"
                      style={{
                        marginBottom: 8,
                        borderColor: token.colorBorderSecondary,
                      }}
                    >
                      <div style={{ marginBottom: 4 }}>
                        <Text strong>
                          {c.profile.email ?? `${c.profile.firstName} ${c.profile.lastName}`}
                        </Text>
                      </div>
                      <div style={{ marginBottom: 4 }}>
                        <Text type="secondary">Name: </Text>
                        <Text>{`${c.profile.firstName} ${c.profile.lastName}`}</Text>
                      </div>
                      <div style={{ marginBottom: 4 }}>
                        <Text type="secondary">Source: </Text>
                        <Text>{c.sources.map((s) => s.sourceName).join(', ') || '—'}</Text>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">Dept: </Text>
                        <Text>{c.profile.departmentName ?? '—'}</Text>
                      </div>
                      <Progress
                        percent={Math.round(c.confidence * 100)}
                        size="small"
                        status={c.confidence >= 0.8 ? 'success' : 'normal'}
                      />
                      <Button
                        type="primary"
                        size="small"
                        icon={<LinkOutlined />}
                        onClick={() => handleLinkClick(c)}
                        loading={linking === c.identityId}
                        style={{ marginTop: 8 }}
                      >
                        Link This One
                      </Button>
                    </Card>
                  ))}
                </Space>
              )}
            </Card>
          </div>
        </div>
      </Modal>

      <Modal
        title="Confirm Link"
        open={!!confirmModal}
        onOk={handleConfirmLink}
        onCancel={() => setConfirmModal(null)}
        okText="Link"
        okButtonProps={{ danger: false }}
      >
        {confirmModal && (
          <p>
            Are you sure you want to link <strong>{displayName(identity)}</strong> (HR) with{' '}
            <strong>
              {confirmModal.target.profile.email ??
                `${confirmModal.target.profile.firstName} ${confirmModal.target.profile.lastName}`}
            </strong>{' '}
            (target)? This merges the records: the HR record's sources move to that identity and the
            HR record's own identity {identity.offboarded ? 'stays deleted' : 'is deleted'}. A link
            cannot be undone from the UI.
          </p>
        )}
      </Modal>
    </>
  );
};

// ── Main Page ────────────────────────────────────────────────────────────

export const UncorrelatedQueue: React.FC = () => {
  const queryClient = useQueryClient();
  const [linkIdentity, setLinkIdentity] = useState<IUncorrelatedIdentity | null>(null);

  const {
    data: identities = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['uncorrelated', 'list'],
    queryFn: fetchUncorrelated,
  });

  const { data: count = 0 } = useQuery({
    queryKey: ['uncorrelated', 'count'],
    queryFn: fetchUncorrelatedCount,
  });

  const { data: candidates = [], isLoading: loadingCandidates } = useQuery({
    queryKey: ['uncorrelated', 'candidates', linkIdentity?._id],
    queryFn: () => fetchCandidates(linkIdentity!._id),
    enabled: !!linkIdentity?._id,
  });

  const linkMutation = useMutation({
    mutationFn: async ({
      identityId,
      targetIdentityId,
    }: {
      identityId: string;
      targetIdentityId: string;
    }) => {
      const { data } = await axiosInstance.post(`${API_BASE}/identity/${identityId}/link`, {
        targetIdentityId,
      });
      return data;
    },
    onSuccess: () => {
      message.success('Identity linked successfully');
      queryClient.invalidateQueries({ queryKey: ['uncorrelated'] });
      setLinkIdentity(null);
    },
    onError: (err: Error) => {
      const axiosErr = err as Error & { response?: { data?: { message?: string } } };
      message.error(axiosErr?.response?.data?.message ?? axiosErr?.message ?? 'Failed to link');
    },
  });

  const createStandaloneMutation = useMutation({
    mutationFn: async (identityId: string) => {
      const { data } = await axiosInstance.post(
        `${API_BASE}/identity/${identityId}/create-standalone`,
      );
      return data;
    },
    onSuccess: () => {
      message.success('Identity marked as standalone');
      queryClient.invalidateQueries({ queryKey: ['uncorrelated'] });
      setLinkIdentity(null);
    },
    onError: (err: Error) => {
      const axiosErr = err as Error & { response?: { data?: { message?: string } } };
      message.error(
        axiosErr?.response?.data?.message ?? axiosErr?.message ?? 'Failed to create standalone',
      );
    },
  });

  const openLink = useCallback((identity: IUncorrelatedIdentity) => {
    setLinkIdentity(identity);
  }, []);

  const closeLink = useCallback(() => {
    setLinkIdentity(null);
  }, []);

  const handleLink = useCallback(
    async (targetIdentityId: string) => {
      if (!linkIdentity) return;
      await linkMutation.mutateAsync({ identityId: linkIdentity._id, targetIdentityId });
    },
    [linkIdentity, linkMutation],
  );

  const handleCreateStandalone = useCallback(async () => {
    if (!linkIdentity) return;
    await createStandaloneMutation.mutateAsync(linkIdentity._id);
  }, [linkIdentity, createStandaloneMutation]);

  const columns: ColumnsType<IUncorrelatedIdentity> = [
    {
      title: 'Name',
      dataIndex: 'firstName',
      key: 'name',
      render: (_, record) => displayName(record),
    },
    {
      title: 'Source',
      key: 'source',
      render: (_, record) => primarySource(record),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, record) => {
        const status = record.metadata?.correlationStatus ?? 'uncorrelated';
        return (
          <Space size={4} wrap>
            <Tag color={status === 'ambiguous' ? 'orange' : 'blue'}>
              {status === 'ambiguous' ? 'Ambiguous' : 'Unlinked'}
            </Tag>
            {record.offboarded && <Tag>Offboarded, ready to link</Tag>}
          </Space>
        );
      },
    },
    {
      title: 'Candidates',
      key: 'candidates',
      render: (_, record) => {
        const n = record.metadata?.ambiguousCandidates?.length ?? 0;
        return n > 0 ? `${n} match${n !== 1 ? 'es' : ''}` : '0 matches';
      },
    },
    {
      title: 'Action',
      key: 'action',
      render: (_, record) => (
        <Button
          type="primary"
          size="small"
          icon={<LinkOutlined />}
          onClick={() => openLink(record)}
        >
          Link
        </Button>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Uncorrelated queue"
        subtitle={
          isLoading
            ? 'Identities that could not be matched automatically'
            : `${count} identit${count === 1 ? 'y needs' : 'ies need'} manual linking`
        }
        actions={
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            Refresh
          </Button>
        }
      />

      <Card>
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : identities.length === 0 ? (
          <EmptyState
            title="All identities are linked"
            description="No uncorrelated identities need attention."
          />
        ) : (
          <Table
            dataSource={identities}
            columns={columns}
            rowKey="_id"
            pagination={{ pageSize: 20 }}
            size="small"
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>

      <LinkModal
        open={!!linkIdentity}
        identity={linkIdentity}
        candidates={candidates}
        loadingCandidates={loadingCandidates}
        onLink={handleLink}
        onCreateStandalone={handleCreateStandalone}
        onClose={closeLink}
      />
    </PageContainer>
  );
};
