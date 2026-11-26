/**
 * UserList Component (2026 Edition)
 *
 * This component displays the Identity Hub - a central view of all user "golden records"
 * synchronized from various source systems (HR, AD, etc.).
 *
 * Key Features:
 * - Displays comprehensive user information with all new StandardUserDto fields
 * - Rich display including job title, employment type, location, and more
 * - Provides a "Provision" button that triggers the onboarding workflow via Temporal
 * - Opens a real-time "Glass Box" dashboard showing the provisioning progress and activities
 * - Tag-based filtering and categorization
 * - Priority and VIP user highlighting
 * - A row opens the identity page (/identities/:id). Page, page size and the conflicts filter
 *   live in the URL (?page=&pageSize=&conflicts=1), so Back from the identity page restores them.
 */

import React, { useState, memo, useMemo, useCallback, useRef } from 'react';
import { Table, Button, Space, Typography, Tag, Tooltip, Avatar, theme, Switch, Grid } from 'antd';
import type { TablePaginationConfig } from 'antd/es/table';
import {
  PlayCircleOutlined,
  DatabaseOutlined,
  UserOutlined,
  CrownOutlined,
  EnvironmentOutlined,
  PhoneOutlined,
  PlusOutlined,
  UserAddOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useNotification, useInvalidate } from '@api/resource-hooks';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { axiosInstance } from '@api/data';
import { fetchOpenDriftCounts, reconciliationKeys } from '@api/reconciliation-api';
import { fetchRiskScores, intelligenceKeys } from '@api/intelligence-api';
import { identityKeys } from '@api/identity-api';
import { API_BASE } from '@api/constants';
import {
  IStandardUser,
  UserStatus,
  UserPriority,
  EmploymentType,
  getUserDisplayName,
  getUserStatusColor,
  getEmploymentTypeLabel,
} from '../../interfaces';
import type { IStandardUserWithMeta } from './components/user-detail.types';
import { resolveIdentityId } from './components/user-detail.types';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ProvisioningProgress } from '../../components/dashboard/ProvisioningProgress';
import { CreateUserModal } from './CreateUserModal';
import { OnboardingWizard } from './OnboardingWizard';
import { identityPath } from './identity-path';
import type { FromState } from '../../utils/back-path';
import { LiveBadge } from '@shared/LiveBadge';
import { isHighRiskScore } from '@config/risk';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { usePermission } from '../../auth/usePermission';

const { Text } = Typography;

type SyncStatus = 'high-risk' | 'drift' | 'in-sync';
const SyncStatusCell = memo(({ status, riskScore }: { status: SyncStatus; riskScore?: number }) => {
  const { token } = theme.useToken();
  const tooltip =
    status === 'high-risk'
      ? `High risk (${riskScore ?? 0})`
      : status === 'drift'
        ? 'Drift detected'
        : 'In sync, low risk';
  const icon =
    status === 'high-risk' ? (
      <ExclamationCircleOutlined style={{ color: token.colorError }} />
    ) : status === 'drift' ? (
      <WarningOutlined style={{ color: token.colorWarning }} />
    ) : (
      <CheckCircleOutlined style={{ color: token.colorSuccess }} />
    );
  return (
    <Tooltip title={tooltip}>
      <span role="img" aria-label={tooltip}>
        {icon}
      </span>
    </Tooltip>
  );
});
SyncStatusCell.displayName = 'SyncStatusCell';

/** The identity's `_id`, the key its drift records and risk scores carry. */
function identityIdOf(record: IStandardUser): string | undefined {
  return (
    (record as { _id?: unknown })._id?.toString?.() || (record as { id?: string }).id || undefined
  );
}

export const UserList = () => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const navigate = useNavigate();
  const location = useLocation();
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  // Creating a user, a new hire and a pipeline run need operator (POST /identity, /onboarding/start)
  const canOperate = usePermission('operator');
  const { open } = useNotification();
  // List state in the URL, so returning from an identity page restores it.
  const [searchParams, setSearchParams] = useSearchParams();
  const conflictsOnly = searchParams.get('conflicts') === '1';
  const current = Math.max(1, Number(searchParams.get('page')) || 1);
  const pageSize = Math.max(1, Number(searchParams.get('pageSize')) || 10);
  const setListState = useCallback(
    (next: { page?: number; pageSize?: number; conflicts?: boolean }) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          const put = (key: string, value: string | null) =>
            value === null ? params.delete(key) : params.set(key, value);
          if (next.page !== undefined) put('page', next.page > 1 ? String(next.page) : null);
          if (next.pageSize !== undefined)
            put('pageSize', next.pageSize !== 10 ? String(next.pageSize) : null);
          if (next.conflicts !== undefined) put('conflicts', next.conflicts ? '1' : null);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const setCurrent = (page: number) => setListState({ page });
  const setConflictsOnly = (conflicts: boolean) => setListState({ conflicts });

  const { data: riskScores = [] } = useQuery({
    queryKey: intelligenceKeys.riskScores(),
    queryFn: () => fetchRiskScores(200),
  });

  const conflictsQuery = useQuery({
    queryKey: identityKeys.conflicts(),
    queryFn: async () => {
      const res = await axiosInstance.get(`${API_BASE}/identity/conflicts`);
      return res.data ?? [];
    },
  });
  const { data: conflicts = [] } = conflictsQuery;

  const conflictEmails = useMemo(
    () =>
      new Set(
        (conflicts as { email?: string }[])
          .map((c) => c.email)
          .filter((e): e is string => Boolean(e)),
      ),
    [conflicts],
  );

  const riskMap = useMemo(() => {
    const map = new Map<string, number>();
    const riskScoresList = Array.isArray(riskScores) ? riskScores : [];
    for (const r of riskScoresList) {
      if (r.identityId) map.set(r.identityId, r.riskScore);
    }
    return map;
  }, [riskScores]);

  const identityListQuery = useQuery({
    queryKey: identityKeys.listPaginated({
      start: (current - 1) * pageSize,
      end: current * pageSize,
    }),
    queryFn: async () => {
      const start = (current - 1) * pageSize;
      const end = start + pageSize;
      const res = await axiosInstance.get<IStandardUser[]>(
        `${API_BASE}/identity?_start=${start}&_end=${end}`,
      );
      const total = Number(res.headers?.['x-total-count'] ?? NaN);
      return {
        data: Array.isArray(res.data) ? res.data : [],
        total: Number.isFinite(total) ? total : Array.isArray(res.data) ? res.data.length : 0,
      };
    },
    enabled: !conflictsOnly,
  });

  const tablePagination: TablePaginationConfig = {
    current,
    pageSize,
    total: identityListQuery.data?.total ?? 0,
    showSizeChanger: true,
    onChange: (page, size) => {
      setListState({ page, pageSize: size || pageSize });
    },
  };

  const listQuery = conflictsOnly ? conflictsQuery : identityListQuery;
  const listErrorState = (
    <ErrorState
      compact
      title={conflictsOnly ? 'Conflicts could not be loaded' : 'Identities could not be loaded'}
      error={listQuery.error}
      onRetry={() => void listQuery.refetch()}
    />
  );

  const effectiveDataSource = conflictsOnly
    ? (conflicts as IStandardUser[])
    : (identityListQuery.data?.data ?? []);

  // The rows' open drifts: one summary request for the identities shown (per 100 of them)
  const rowIdentityIds = [
    ...new Set(effectiveDataSource.map(identityIdOf).filter((id): id is string => Boolean(id))),
  ];
  const { data: openDriftCounts = {} } = useQuery({
    queryKey: reconciliationKeys.openDriftCounts(rowIdentityIds),
    queryFn: () => fetchOpenDriftCounts(rowIdentityIds),
    enabled: rowIdentityIds.length > 0,
  });

  const getStatusForUser = useCallback(
    (record: IStandardUser): { status: SyncStatus; riskScore?: number } => {
      const identityId = identityIdOf(record);
      const hasDrift = identityId ? (openDriftCounts[identityId] ?? 0) > 0 : false;
      const riskScore = riskMap.get(identityId ?? record.email) ?? 0;
      const isHighRisk = isHighRiskScore(riskScore);
      if (isHighRisk) return { status: 'high-risk', riskScore };
      if (hasDrift) return { status: 'drift' };
      return { status: 'in-sync' };
    },
    [openDriftCounts, riskMap],
  );

  // State to manage the Glass Box dashboard visibility
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const [activeUser, setActiveUser] = useState<IStandardUser | null>(null);
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);

  // State for Create User Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  // State for Onboarding Wizard (+ New Hire)
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  /** The identity whose pipeline start is being sent: its button waits, a second click does nothing. */
  const [startingFor, setStartingFor] = useState<string | null>(null);
  // The state shows on the button; the ref stops a second click before the next render
  const starting = useRef(false);

  const handleProvisionClick = async (record: IStandardUser) => {
    if (starting.current) return;
    starting.current = true;
    setStartingFor(record._id ?? record.email);
    // Open the Glass Box dashboard on this person, with no workflow until the start answers: it
    // must not poll the previous run meanwhile
    setActiveUser(record);
    setWorkflowId(undefined);
    setIsDashboardOpen(true);

    try {
      // Trigger the Onboarding Workflow for the selected user
      const response = await axiosInstance.post(`${API_BASE}/onboarding/start`, {
        email: record.email,
      });

      // Capture the workflow ID from the response
      setWorkflowId(response.data.workflowId);

      open?.({
        message: 'Provisioning Started',
        description: `Workflow initiated for ${record.email}. Watch the progress in the dashboard.`,
        type: 'success',
      });
    } catch (err) {
      open?.({
        message: 'Provisioning Failed',
        description: apiErrorMessage(err, 'The onboarding could not be started.'),
        type: 'error',
      });
      // Close the dashboard on error
      setIsDashboardOpen(false);
    } finally {
      starting.current = false;
      setStartingFor(null);
    }
  };

  const handleCreateUserSuccess = (newWorkflowId?: string) => {
    // Invalidate all identity queries so the new user appears
    invalidate({ resource: 'identity', invalidates: ['list'] });
    queryClient.invalidateQueries({
      predicate: (q) => (q.queryKey as string[])?.[1] === 'identity',
    });
    setCurrent(1); // Go to page 1 where new user is likely to appear
    void identityListQuery.refetch();

    // If workflow was triggered, open the dashboard (on the new person, not the last one shown)
    if (newWorkflowId) {
      setActiveUser(null);
      setWorkflowId(newWorkflowId);
      setIsDashboardOpen(true);
    }
  };

  const handleWizardComplete = (newWorkflowId: string) => {
    invalidate({ resource: 'identity', invalidates: ['list'] });
    queryClient.invalidateQueries({
      predicate: (q) => (q.queryKey as string[])?.[1] === 'identity',
    });
    setCurrent(1);
    void identityListQuery.refetch();
    setActiveUser(null);
    setWorkflowId(newWorkflowId);
    setIsDashboardOpen(true);
  };

  const handleRowClick = (record: IStandardUser) => {
    const id = resolveIdentityId(record as IStandardUserWithMeta);
    if (!id) return;
    const state: FromState = { from: location.pathname + location.search };
    navigate(identityPath(id), { state });
  };

  return (
    <>
      <PageContainer>
        <PageHeader
          title="Identity hub"
          titleExtra={<LiveBadge />}
          subtitle="Golden records synchronised from HR and target systems"
          actions={
            canOperate ? (
              <>
                <Button icon={<PlusOutlined />} onClick={() => setIsCreateModalOpen(true)}>
                  Create user
                </Button>
                <Button
                  type="primary"
                  icon={<UserAddOutlined />}
                  onClick={() => setIsWizardOpen(true)}
                >
                  New hire
                </Button>
              </>
            ) : null
          }
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Switch
            size="small"
            checked={conflictsOnly}
            onChange={setConflictsOnly}
            aria-label="Show conflicts only"
          />
          <Text type="secondary" style={{ fontSize: 13 }}>
            Show conflicts only
          </Text>
          {conflicts.length > 0 && (
            <Tag color="warning" style={{ marginLeft: 4 }}>
              {conflicts.length} conflicts
            </Tag>
          )}
        </div>
        <div role="region" aria-label="User list">
          <Table
            dataSource={effectiveDataSource}
            loading={!conflictsOnly && identityListQuery.isLoading}
            // A failed load is not an empty hub
            locale={listQuery.isError ? { emptyText: listErrorState } : undefined}
            pagination={conflictsOnly ? false : tablePagination}
            rowKey="_id"
            size="middle"
            scroll={{ x: 1400 }}
            onRow={(record) => ({
              onClick: () => handleRowClick(record),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) handleRowClick(record);
              },
              tabIndex: 0,
              'aria-label': `Open details for ${getUserDisplayName(record)}`,
              style: { cursor: 'pointer' },
            })}
          >
            {/* User Column with Avatar and Rich Info */}
            <Table.Column
              title="User"
              width={290}
              fixed={screens.md ? 'left' : undefined}
              render={(_, record: IStandardUser) => (
                <Space size="middle">
                  <Avatar
                    icon={record.firstName || record.lastName ? undefined : <UserOutlined />}
                    style={{
                      backgroundColor: token.colorPrimaryBg,
                      color: token.colorPrimary,
                      fontSize: 12,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {record.firstName?.[0]}
                    {record.lastName?.[0]}
                  </Avatar>
                  <Space direction="vertical" size={0}>
                    <Space size="small">
                      <Text strong>{getUserDisplayName(record)}</Text>
                      {record.priority === UserPriority.VIP && (
                        <Tooltip title="VIP User - High Priority">
                          <CrownOutlined style={{ color: token.colorWarning }} />
                        </Tooltip>
                      )}
                      {(!conflictsOnly && conflictEmails.has(record.email)) ||
                      (record as IStandardUserWithMeta).metadata?.requiresReview ||
                      (record as IStandardUserWithMeta).metadata?.correlationConflict ? (
                        <Tooltip title="Correlation conflict — review required">
                          <WarningOutlined style={{ color: token.colorWarning }} />
                        </Tooltip>
                      ) : (record as IStandardUserWithMeta).metadata?.correlationStatus ===
                          'uncorrelated' ||
                        (record as IStandardUserWithMeta).metadata?.correlationStatus ===
                          'ambiguous' ? (
                        <Tooltip title="Uncorrelated — link in Uncorrelated Queue">
                          <QuestionCircleOutlined
                            style={{ color: token.colorPrimary, cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate('/reconciliation/uncorrelated');
                            }}
                          />
                        </Tooltip>
                      ) : null}
                    </Space>
                    <Text
                      type="secondary"
                      className="mono"
                      style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {record.email}
                    </Text>
                    {record.jobTitle && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {record.jobTitle}
                      </Text>
                    )}
                  </Space>
                </Space>
              )}
            />

            {/* Department & Division - Only show if has data */}
            {effectiveDataSource?.some(
              (u: IStandardUser) => u?.departmentCode || u?.departmentName || u?.division,
            ) && (
              <Table.Column
                title="Department"
                width={150}
                render={(_, record: IStandardUser) => (
                  <Space direction="vertical" size={0}>
                    {(record.departmentCode || record.departmentName) && (
                      <Tag>{record.departmentCode || record.departmentName}</Tag>
                    )}
                    {record.division && (
                      <Text type="secondary" style={{ fontSize: '11px' }}>
                        {record.division}
                      </Text>
                    )}
                  </Space>
                )}
              />
            )}

            {/* Employment Type - Only show if has data */}
            {effectiveDataSource?.some((u: IStandardUser) => u?.employmentType) && (
              <Table.Column
                title="Employment"
                dataIndex="employmentType"
                width={130}
                render={(value: EmploymentType) =>
                  value ? (
                    <Tag bordered={false}>{getEmploymentTypeLabel(value)}</Tag>
                  ) : (
                    <Text type="secondary">-</Text>
                  )
                }
              />
            )}

            {/* Location - Only show if has data */}
            {effectiveDataSource?.some((u: IStandardUser) => u?.location || u?.city) && (
              <Table.Column
                title="Location"
                width={150}
                render={(_, record: IStandardUser) =>
                  record.location || record.city ? (
                    <Space size="small">
                      <EnvironmentOutlined style={{ color: token.colorTextTertiary }} />
                      <Space direction="vertical" size={0}>
                        {record.location && (
                          <Text style={{ fontSize: '12px' }}>{record.location}</Text>
                        )}
                        {record.city && record.countryCode && (
                          <Text type="secondary" style={{ fontSize: '11px' }}>
                            {record.city}, {record.countryCode}
                          </Text>
                        )}
                      </Space>
                    </Space>
                  ) : (
                    <Text type="secondary">-</Text>
                  )
                }
              />
            )}

            {/* Contact - Only show if has data */}
            {effectiveDataSource?.some((u: IStandardUser) => u?.mobilePhone || u?.workPhone) && (
              <Table.Column
                title="Contact"
                width={140}
                render={(_, record: IStandardUser) =>
                  record.mobilePhone || record.workPhone ? (
                    <Space direction="vertical" size={0}>
                      {record.mobilePhone && (
                        <Space size={4}>
                          <PhoneOutlined
                            style={{ fontSize: '10px', color: token.colorTextTertiary }}
                          />
                          <Text style={{ fontSize: '11px' }}>{record.mobilePhone}</Text>
                        </Space>
                      )}
                      {record.workPhone && (
                        <Text type="secondary" style={{ fontSize: '10px' }}>
                          Work: {record.workPhone}
                        </Text>
                      )}
                    </Space>
                  ) : (
                    <Text type="secondary">-</Text>
                  )
                }
              />
            )}

            {/* Drift/Risk Status */}
            <Table.Column
              title="Sync"
              width={80}
              render={(_, record: IStandardUser) => {
                const { status, riskScore } = getStatusForUser(record);
                return <SyncStatusCell status={status} riskScore={riskScore} />;
              }}
            />

            {/* Status */}
            <Table.Column
              dataIndex="status"
              title="Status"
              width={100}
              render={(value: UserStatus) => <Tag color={getUserStatusColor(value)}>{value}</Tag>}
            />

            {/* Tags */}
            <Table.Column
              title="Tags"
              dataIndex="tags"
              width={150}
              render={(tags: string[]) =>
                tags && tags.length > 0 ? (
                  <Space size={[0, 4]} wrap>
                    {tags.slice(0, 2).map((tag) => (
                      <Tag key={tag} bordered={false} style={{ fontSize: 11 }}>
                        {tag}
                      </Tag>
                    ))}
                    {tags.length > 2 && (
                      <Tooltip title={tags.slice(2).join(', ')}>
                        <Tag bordered={false} style={{ fontSize: 11 }}>
                          +{tags.length - 2}
                        </Tag>
                      </Tooltip>
                    )}
                  </Space>
                ) : null
              }
            />

            {/* Source System */}
            <Table.Column
              title="Source"
              width={130}
              render={(_, record: IStandardUser) => (
                <Space direction="vertical" size={0}>
                  <Space size="small">
                    <DatabaseOutlined style={{ fontSize: '10px' }} />
                    <Text style={{ fontSize: 12 }}>{record.sourceSystem || 'Manual'}</Text>
                  </Space>
                  {record.sourceUserId && (
                    <Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                      {record.sourceUserId}
                    </Text>
                  )}
                </Space>
              )}
            />

            {/* Last Updated */}
            <Table.Column
              title="Last Updated"
              dataIndex="updatedAt"
              width={130}
              render={(value) => (value ? dayjs(value).format('MMM D, YYYY') : 'N/A')}
            />

            {/* Actions */}
            {canOperate && (
              <Table.Column
                title="Actions"
                width={140}
                fixed={screens.md ? 'right' : undefined}
                render={(_, record: IStandardUser) => (
                  // The row opens the identity page; a click on the button (also one antd swallows
                  // while it is loading or disabled) only starts the pipeline
                  <span onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="primary"
                      ghost
                      icon={<PlayCircleOutlined />}
                      loading={startingFor === (record._id ?? record.email)}
                      disabled={
                        startingFor !== null && startingFor !== (record._id ?? record.email)
                      }
                      onClick={() => void handleProvisionClick(record)}
                      size="small"
                    >
                      Run Pipeline
                    </Button>
                  </span>
                )}
              />
            )}
          </Table>
        </div>

        {/* Glass Box Dashboard - Shows real-time provisioning progress */}
        <ProvisioningProgress
          visible={isDashboardOpen}
          onClose={() => setIsDashboardOpen(false)}
          userName={activeUser ? getUserDisplayName(activeUser) : ''}
          workflowId={workflowId}
        />

        {/* Create User Modal */}
        <CreateUserModal
          open={isCreateModalOpen}
          onClose={() => setIsCreateModalOpen(false)}
          onSuccess={handleCreateUserSuccess}
        />

        {/* Onboarding Wizard (+ New Hire) */}
        <OnboardingWizard
          open={isWizardOpen}
          onClose={() => setIsWizardOpen(false)}
          onComplete={handleWizardComplete}
        />
      </PageContainer>
    </>
  );
};
