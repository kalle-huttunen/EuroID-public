/**
 * Access Reviews — Intelligence Layer
 *
 * Campaign list, create, activate, and decision flow.
 * My Reviews tab for current user's pending items.
 * Reviewer quality tab (super-admin, like GET /intelligence/reviewer-quality): how each reviewer
 * decided in the completed campaigns; a completed campaign's modal opens it on that campaign.
 */

import React, { useState } from 'react';
import {
  App,
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  DatePicker,
  Switch,
  Progress,
  Tabs,
  Empty,
  Skeleton,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, PlayCircleOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from '../../auth/auth-context';
import { CancelCampaignButton, CancelCampaignModal } from './CancelCampaign';
import {
  fetchCampaigns,
  fetchCampaign,
  fetchCampaignItems,
  fetchMyReviews,
  createCampaign,
  activateCampaign,
  decideReviewItem,
  intelligenceKeys,
  type ReviewCampaign,
  type ReviewItem,
  type CampaignStatus,
} from '@api/intelligence-api';
import { useSocket } from '@api/realtime';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { RevocationCell, RevocationSummaryTags, RevokeReviewModal } from './ReviewRevocation';
import { ReviewerQualityTab } from './ReviewerQualityTab';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { usePermission } from '../../auth/usePermission';
import { ErrorState } from '@shared/ErrorState';

const { Text } = Typography;
const PAGE_SIZE = 20;
/** Wide enough for the review items at desktop widths; smaller screens cap it at the viewport. */
const CAMPAIGN_MODAL_WIDTH = 1120;
/**
 * Below this width the review items tables (campaign modal, My Reviews) scroll inside their
 * container instead of spilling out of it.
 */
const REVIEW_ITEMS_MIN_WIDTH = 1000;
/** Below this width (phones) the campaigns table scrolls inside its card, not the page. */
const CAMPAIGNS_MIN_WIDTH = 900;

const SCOPE_OPTIONS = [
  { value: 'all', label: 'All identities' },
  { value: 'department', label: 'Department' },
  { value: 'role', label: 'Role' },
  { value: 'system', label: 'System' },
];

const FREQUENCY_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMI_ANNUAL', label: 'Semi-Annual' },
  { value: 'ANNUAL', label: 'Annual' },
];

const ESCALATE_TO_OPTIONS = [
  { value: 'MANAGER', label: 'Manager' },
  { value: 'ADMIN', label: 'Admin' },
];

const STATUS_COLORS: Record<CampaignStatus, string> = {
  DRAFT: 'default',
  ACTIVE: 'processing',
  COMPLETED: 'success',
  CANCELLED: 'default',
};

export const AccessReviews: React.FC = () => {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const auth = useAuthContext();
  const { status } = useSocket();
  const [activeTab, setActiveTab] = useState('campaigns');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [revokeItem, setRevokeItem] = useState<ReviewItem | null>(null);
  const [cancelling, setCancelling] = useState<ReviewCampaign | null>(null);
  // The API's roles: create needs policy-admin, activate super-admin, a decision operator
  const isSuperAdmin = usePermission('super-admin');
  const canCreate = usePermission('policy-admin');
  const canDecide = usePermission('operator');
  // Table pages (1-based); the API's pages start at 0 and return at most 100 rows
  const [campaignsPage, setCampaignsPage] = useState(1);
  const [itemsPage, setItemsPage] = useState(1);
  const [myReviewsPage, setMyReviewsPage] = useState(1);
  const [qualityCampaignId, setQualityCampaignId] = useState<string | undefined>();
  const [form] = Form.useForm();

  const campaignsQuery = useQuery({
    queryKey: intelligenceKeys.campaigns({ page: campaignsPage }),
    queryFn: () => fetchCampaigns({ page: campaignsPage - 1, limit: PAGE_SIZE }),
  });
  const { data: campaignsRes, isLoading: campaignsLoading } = campaignsQuery;

  const { data: campaignDetail, isLoading: campaignLoading } = useQuery({
    queryKey: intelligenceKeys.campaign(selectedCampaignId!),
    queryFn: () => fetchCampaign(selectedCampaignId!),
    enabled: !!selectedCampaignId,
  });

  const { data: itemsRes, isLoading: itemsLoading } = useQuery({
    queryKey: intelligenceKeys.campaignItems(selectedCampaignId!, { page: itemsPage }),
    queryFn: () =>
      fetchCampaignItems(selectedCampaignId!, { page: itemsPage - 1, limit: PAGE_SIZE }),
    enabled: !!selectedCampaignId,
  });

  const myReviewsQuery = useQuery({
    queryKey: intelligenceKeys.myReviews({ decision: 'pending', page: myReviewsPage }),
    queryFn: () =>
      fetchMyReviews({ decision: 'pending', page: myReviewsPage - 1, limit: PAGE_SIZE }),
    enabled: activeTab === 'my-reviews',
  });
  const { data: myReviewsRes, isLoading: myReviewsLoading } = myReviewsQuery;

  /** Opens a campaign's detail on its first page of items. */
  const openCampaign = (campaignId: string | null) => {
    setItemsPage(1);
    setSelectedCampaignId(campaignId);
  };

  const createMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.campaignsPrefix() });
      setCreateModalOpen(false);
      form.resetFields();
      message.success('Campaign created');
    },
    // The API's reason, e.g. a system scope that names no known system. The toast is not
    // returned: React Query would keep the mutation pending until it closes.
    onError: (e: Error) => {
      message.error('Failed to create: ' + apiErrorMessage(e, e.message));
    },
  });

  const activateMutation = useMutation({
    mutationFn: activateCampaign,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.campaignsPrefix() });
      if (selectedCampaignId) {
        // The campaign's key is the prefix of its items' keys: both are read again
        queryClient.invalidateQueries({
          queryKey: intelligenceKeys.campaign(selectedCampaignId),
        });
      }
      message.success('Campaign activated');
    },
    onError: (e: Error) => {
      message.error('Failed to activate: ' + apiErrorMessage(e, e.message));
    },
  });

  const decideMutation = useMutation({
    mutationFn: ({
      itemId,
      decision,
      justification,
    }: {
      itemId: string;
      decision: 'approved' | 'revoked';
      justification?: string;
    }) => decideReviewItem(itemId, decision, justification),
    onSuccess: () => {
      setRevokeItem(null);
      // The prefix: `myReviews()` ends in `undefined` and matches no query with params.
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.myReviewsPrefix() });
      if (selectedCampaignId) {
        // The campaign's key is the prefix of its items' keys: both are read again
        queryClient.invalidateQueries({
          queryKey: intelligenceKeys.campaign(selectedCampaignId),
        });
      }
      message.success('Decision recorded');
    },
    // The API's reason, e.g. a campaign cancelled meanwhile (409): its items leave My Reviews
    onError: (e: Error) => {
      message.error('Failed: ' + apiErrorMessage(e, e.message));
      queryClient.invalidateQueries({ queryKey: intelligenceKeys.myReviewsPrefix() });
    },
  });

  const campaigns = campaignsRes?.data ?? [];
  const items = itemsRes?.data ?? [];
  const myReviews = myReviewsRes?.data ?? [];
  const stats = campaignDetail?.stats;

  const handleCreate = () => {
    form.validateFields().then((values) => {
      const scopeType = values.scopeType || 'all';
      const body: Parameters<typeof createCampaign>[0] = {
        name: values.name,
        description: values.description,
        scope: {
          type: scopeType,
          value: scopeType !== 'all' ? values.scopeValue : undefined,
        },
        deadline:
          values.deadline?.toISOString?.() ??
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        autoRevokeOnExpiry: values.autoRevokeOnExpiry ?? false,
      };
      if (values.recurring) {
        body.recurrence = {
          enabled: true,
          frequency: values.recurrenceFrequency ?? 'QUARTERLY',
        };
      }
      if (values.escalationEnabled) {
        body.escalation = {
          enabled: true,
          escalateAfterDays: values.escalateAfterDays ?? 7,
          escalateTo: values.escalateTo ?? 'MANAGER',
        };
      }
      createMutation.mutate(body);
    });
  };

  const campaignColumns: ColumnsType<ReviewCampaign> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, r) => (
        <Space>
          <span>{name}</span>
          {r.recurrence?.enabled && r.recurrence.frequency && (
            <Tag color="blue">{r.recurrence.frequency.replace('_', '-')}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Scope',
      key: 'scope',
      render: (_, r) =>
        r.scope.type === 'all' ? 'All' : `${r.scope.type}: ${r.scope.value || '—'}`,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s: CampaignStatus) => <Tag color={STATUS_COLORS[s]}>{s}</Tag>,
    },
    {
      title: 'Deadline',
      dataIndex: 'deadline',
      key: 'deadline',
      render: (d: string, r: ReviewCampaign) => (
        <Space direction="vertical" size={0}>
          <span>{dayjs(d).format('YYYY-MM-DD')}</span>
          {r.recurrence?.enabled && r.recurrence.nextRunAt && r.status === 'COMPLETED' && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Next run: {dayjs(r.recurrence.nextRunAt).format('YYYY-MM-DD')}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Progress',
      key: 'progress',
      render: (_, r) => {
        const total = r.stats?.totalItems ?? 0;
        const done = (r.stats?.approved ?? 0) + (r.stats?.revoked ?? 0);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return <Progress percent={pct} size="small" style={{ width: 80 }} />;
      },
    },
    { title: 'Created By', dataIndex: 'createdBy', key: 'createdBy' },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" onClick={() => openCampaign(r.campaignId)}>
            View
          </Button>
          {r.recurrence?.previousCampaignId && (
            <Button
              type="link"
              size="small"
              onClick={() => openCampaign(r.recurrence!.previousCampaignId!)}
            >
              Previous
            </Button>
          )}
          <CancelCampaignButton campaign={r} onClick={setCancelling} />
        </Space>
      ),
    },
  ];

  // Lower-cased: the API matches the assigned reviewer without case when it records a decision
  const currentUserEmail = (
    (auth.user?.profile?.email as string) ||
    (auth.user?.profile as Record<string, string>)?.preferred_username ||
    ''
  ).toLowerCase();
  const isMyPendingItem = (r: ReviewItem) =>
    canDecide &&
    r.decision === 'pending' &&
    !!currentUserEmail &&
    r.reviewerId?.toLowerCase() === currentUserEmail;

  // Fixed widths and fewer columns (name with email, decision with its date and context), so the
  // items fit the campaign modal; Entitlements takes the rest and its tags wrap.
  const itemColumns: ColumnsType<ReviewItem> = [
    {
      title: 'Identity',
      key: 'identity',
      width: 190,
      render: (_: unknown, r: ReviewItem) => (
        <div style={{ minWidth: 0 }}>
          <Text ellipsis={{ tooltip: r.identityName }} style={{ display: 'block' }}>
            {r.identityName}
          </Text>
          <Text
            type="secondary"
            ellipsis={{ tooltip: r.identityEmail }}
            style={{ display: 'block', fontSize: 12 }}
          >
            {r.identityEmail}
          </Text>
        </div>
      ),
    },
    {
      title: 'Entitlements',
      dataIndex: 'entitlements',
      key: 'entitlements',
      render: (ent: ReviewItem['entitlements']) =>
        ent?.length ? (
          <Space wrap size={4}>
            {ent.slice(0, 3).map((e, i) => (
              <Tag key={i} style={{ whiteSpace: 'normal' }}>
                {e.system}: {e.name}
              </Tag>
            ))}
            {ent.length > 3 && <Tag>+{ent.length - 3}</Tag>}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: 'Decision',
      dataIndex: 'decision',
      key: 'decision',
      width: 150,
      render: (d: string, r: ReviewItem) => (
        <Space direction="vertical" size={2}>
          <Tag
            color={
              d === 'approved'
                ? 'green'
                : d === 'revoked'
                  ? 'red'
                  : d === 'pending'
                    ? 'orange'
                    : 'default'
            }
          >
            {d}
          </Tag>
          {r.decidedAt && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayjs(r.decidedAt).format('YYYY-MM-DD HH:mm')}
            </Text>
          )}
          {r.previousDecision === 'APPROVED' && r.previousDecisionDate && (
            <Tag color="green" style={{ whiteSpace: 'normal' }}>
              Previously certified {dayjs(r.previousDecisionDate).format('YYYY-MM-DD')}
            </Tag>
          )}
          {r.previousDecision === 'REVOKED' && <Tag color="orange">Previously revoked</Tag>}
        </Space>
      ),
    },
    {
      title: 'Revocation',
      key: 'revocation',
      width: 190,
      render: (_: unknown, r: ReviewItem) => (
        <RevocationCell
          item={r}
          campaignStatus={campaignDetail?.status}
          autoRevokeOnExpiry={campaignDetail?.autoRevokeOnExpiry}
        />
      ),
    },
    {
      title: 'Reviewer',
      dataIndex: 'reviewerId',
      key: 'reviewerId',
      width: 150,
      render: (reviewerId: string, r: ReviewItem) => (
        <div style={{ minWidth: 0 }}>
          <Text ellipsis={{ tooltip: reviewerId }} style={{ display: 'block' }}>
            {reviewerId}
          </Text>
          {r.escalatedFrom && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Escalated from {r.escalatedFrom}
            </Text>
          )}
        </div>
      ),
    },
    ...(campaignDetail?.status === 'ACTIVE'
      ? [
          {
            title: 'Actions',
            key: 'actions',
            width: 120,
            render: (_: unknown, r: ReviewItem) =>
              isMyPendingItem(r) ? (
                <Space direction="vertical" size={0}>
                  <Button
                    type="link"
                    size="small"
                    icon={<CheckOutlined />}
                    onClick={() =>
                      decideMutation.mutate({
                        itemId: r.itemId,
                        decision: 'approved',
                      })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger
                    icon={<CloseOutlined />}
                    onClick={() => setRevokeItem(r)}
                  >
                    Revoke
                  </Button>
                </Space>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Access reviews"
        titleExtra={status === 'connected' ? <Tag color="success">Live</Tag> : null}
        subtitle="Certification campaigns and the review items assigned to you."
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'campaigns',
            label: 'Campaigns',
            children: (
              <>
                <Card
                  extra={
                    canCreate ? (
                      <Button
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => setCreateModalOpen(true)}
                      >
                        Create Campaign
                      </Button>
                    ) : null
                  }
                >
                  {campaignsLoading ? (
                    <Skeleton active />
                  ) : campaignsQuery.isError ? (
                    <ErrorState
                      title="Campaigns could not be loaded"
                      error={campaignsQuery.error}
                      onRetry={() => void campaignsQuery.refetch()}
                    />
                  ) : campaigns.length === 0 ? (
                    <Empty
                      description="No campaigns yet. Create one to get started."
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  ) : (
                    <Table
                      columns={campaignColumns}
                      dataSource={campaigns}
                      rowKey="campaignId"
                      pagination={{
                        current: campaignsPage,
                        pageSize: PAGE_SIZE,
                        total: campaignsRes?.total ?? 0,
                        onChange: setCampaignsPage,
                        showSizeChanger: false,
                        hideOnSinglePage: true,
                      }}
                      size="small"
                      scroll={{ x: CAMPAIGNS_MIN_WIDTH }}
                    />
                  )}
                </Card>

                {selectedCampaignId && (
                  <Modal
                    title={campaignDetail?.name ?? 'Campaign Detail'}
                    open={!!selectedCampaignId}
                    onCancel={() => openCampaign(null)}
                    footer={null}
                    width={CAMPAIGN_MODAL_WIDTH}
                  >
                    {campaignLoading ? (
                      <Skeleton active />
                    ) : campaignDetail ? (
                      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                        <Space wrap>
                          <Tag color={STATUS_COLORS[campaignDetail.status]}>
                            {campaignDetail.status}
                          </Tag>
                          {campaignDetail.recurrence?.enabled &&
                            campaignDetail.recurrence.frequency && (
                              <Tag color="blue">
                                {campaignDetail.recurrence.frequency.replace('_', '-')}
                              </Tag>
                            )}
                          {campaignDetail.recurrence?.previousCampaignId && (
                            <Button
                              type="link"
                              size="small"
                              onClick={() => {
                                setSelectedCampaignId(null);
                                setTimeout(
                                  () =>
                                    openCampaign(campaignDetail.recurrence!.previousCampaignId!),
                                  0,
                                );
                              }}
                            >
                              View previous campaign
                            </Button>
                          )}
                          {campaignDetail.status === 'COMPLETED' && isSuperAdmin && (
                            <Button
                              type="link"
                              size="small"
                              onClick={() => {
                                setSelectedCampaignId(null);
                                setQualityCampaignId(campaignDetail.campaignId);
                                setActiveTab('reviewer-quality');
                              }}
                            >
                              Reviewer quality
                            </Button>
                          )}
                          {campaignDetail.status === 'DRAFT' && isSuperAdmin && (
                            <Button
                              type="primary"
                              icon={<PlayCircleOutlined />}
                              onClick={() => activateMutation.mutate(campaignDetail.campaignId)}
                              loading={activateMutation.isPending}
                            >
                              Activate
                            </Button>
                          )}
                        </Space>
                        {stats && (
                          <Space>
                            <Tag color="default">Total: {stats.totalItems}</Tag>
                            <Tag color="green">Approved: {stats.approved}</Tag>
                            <Tag color="red">Revoked: {stats.revoked}</Tag>
                            <Tag color="orange">Pending: {stats.pending}</Tag>
                            <Tag color="default">Expired: {stats.expired}</Tag>
                          </Space>
                        )}
                        <RevocationSummaryTags summary={campaignDetail.revocationSummary} />
                        <Table
                          columns={itemColumns}
                          dataSource={items}
                          rowKey="itemId"
                          loading={itemsLoading}
                          pagination={{
                            current: itemsPage,
                            pageSize: PAGE_SIZE,
                            total: itemsRes?.total ?? 0,
                            onChange: setItemsPage,
                            showSizeChanger: false,
                            hideOnSinglePage: true,
                          }}
                          size="small"
                          tableLayout="fixed"
                          scroll={{ x: REVIEW_ITEMS_MIN_WIDTH }}
                        />
                      </Space>
                    ) : null}
                  </Modal>
                )}
              </>
            ),
          },
          {
            key: 'my-reviews',
            label: 'My Reviews',
            children: (
              <Card>
                {myReviewsLoading ? (
                  <Skeleton active />
                ) : myReviewsQuery.isError ? (
                  <ErrorState
                    title="Your reviews could not be loaded"
                    error={myReviewsQuery.error}
                    onRetry={() => void myReviewsQuery.refetch()}
                  />
                ) : myReviews.length === 0 ? (
                  <Empty
                    description="No pending reviews assigned to you."
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ) : (
                  <Table
                    columns={[
                      ...itemColumns.filter((c) => c.key !== 'actions' && c.key !== 'revocation'),
                      ...(canDecide
                        ? [
                            {
                              title: 'Actions',
                              key: 'actions',
                              render: (_: unknown, r: ReviewItem) => (
                                <Space>
                                  <Button
                                    type="primary"
                                    size="small"
                                    icon={<CheckOutlined />}
                                    onClick={() =>
                                      decideMutation.mutate({
                                        itemId: r.itemId,
                                        decision: 'approved',
                                      })
                                    }
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    danger
                                    size="small"
                                    icon={<CloseOutlined />}
                                    onClick={() => setRevokeItem(r)}
                                  >
                                    Revoke
                                  </Button>
                                </Space>
                              ),
                            },
                          ]
                        : []),
                    ]}
                    dataSource={myReviews}
                    rowKey="itemId"
                    pagination={{
                      current: myReviewsPage,
                      pageSize: PAGE_SIZE,
                      total: myReviewsRes?.total ?? 0,
                      onChange: setMyReviewsPage,
                      showSizeChanger: false,
                      hideOnSinglePage: true,
                    }}
                    size="small"
                    scroll={{ x: REVIEW_ITEMS_MIN_WIDTH }}
                  />
                )}
              </Card>
            ),
          },
          ...(isSuperAdmin
            ? [
                {
                  key: 'reviewer-quality',
                  label: 'Reviewer quality',
                  children: (
                    <Card>
                      <ReviewerQualityTab
                        campaigns={campaigns}
                        campaignId={qualityCampaignId}
                        onCampaignChange={setQualityCampaignId}
                      />
                    </Card>
                  ),
                },
              ]
            : []),
        ]}
      />

      <RevokeReviewModal
        item={revokeItem}
        loading={decideMutation.isPending}
        onCancel={() => setRevokeItem(null)}
        onSubmit={(justification) =>
          revokeItem &&
          decideMutation.mutate({
            itemId: revokeItem.itemId,
            decision: 'revoked',
            justification,
          })
        }
      />

      <CancelCampaignModal campaign={cancelling} onClose={() => setCancelling(null)} />

      {/* Create Campaign Modal */}
      <Modal
        title="Create campaign"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModalOpen(false);
          form.resetFields();
        }}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="Campaign name" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea placeholder="Optional description" rows={2} />
          </Form.Item>
          <Form.Item name="scopeType" label="Scope Type" initialValue="all">
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="scopeValue" label="Scope Value" dependencies={['scopeType']}>
            <Input
              placeholder="e.g. Sales, Engineering"
              disabled={form.getFieldValue('scopeType') === 'all'}
            />
          </Form.Item>
          <Form.Item name="deadline" label="Deadline" initialValue={dayjs().add(30, 'day')}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="autoRevokeOnExpiry"
            label="Auto-revoke on expiry"
            valuePropName="checked"
            initialValue={false}
            extra="Revoked access is always removed when the campaign closes. With this on, access nobody reviewed by the deadline is removed too."
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="recurring"
            label="Recurring campaign"
            valuePropName="checked"
            initialValue={false}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="recurrenceFrequency"
            label="Frequency"
            dependencies={['recurring']}
            initialValue="QUARTERLY"
          >
            <Select
              options={FREQUENCY_OPTIONS}
              placeholder="Select frequency"
              disabled={!form.getFieldValue('recurring')}
            />
          </Form.Item>
          <Form.Item
            name="escalationEnabled"
            label="Enable escalation"
            valuePropName="checked"
            initialValue={false}
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="escalateAfterDays"
            label="Days before escalation"
            dependencies={['escalationEnabled']}
            initialValue={7}
          >
            <InputNumber
              min={1}
              max={365}
              placeholder="e.g. 7"
              style={{ width: '100%' }}
              disabled={!form.getFieldValue('escalationEnabled')}
            />
          </Form.Item>
          <Form.Item
            name="escalateTo"
            label="Escalate to"
            dependencies={['escalationEnabled']}
            initialValue="MANAGER"
          >
            <Select
              options={ESCALATE_TO_OPTIONS}
              placeholder="Manager or Admin"
              disabled={!form.getFieldValue('escalationEnabled')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};
