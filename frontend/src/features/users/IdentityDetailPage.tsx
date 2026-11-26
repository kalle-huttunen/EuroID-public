/**
 * IdentityDetailPage (Identity 360 view), route `/identities/:id`.
 *
 * Owns the page chrome, the profile form instance, save/delete and the tab routing. All tab
 * content is delegated to the tab components in `./components`.
 *
 * Tabs: Profile, Access, Recommendations (operator, like GET /intelligence/recommendations/:id),
 * Drift, Credentials (operator, like GET /credential-lifecycle/inventory/:id), Timeline, Risk,
 * Raw data. The open tab is `?tab=` (Profile when absent or not offered), so a tab
 * can be linked; switching tabs replaces the history entry, so the browser's
 * back button leaves the page. [Back] returns to where the page was opened from (the identity
 * list keeps its page and filter in its own URL), or to the Identity hub for a deep link.
 * Profile changes are saved from a bar that stays at the bottom of the window. Save and Delete
 * need operator, like PATCH and DELETE /identity/:id. [Access graph] opens the Access explorer on
 * this identity (`/access-explorer?identity=`, every role).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  App,
  Tabs,
  Form,
  Button,
  Space,
  Tag,
  Typography,
  Badge,
  Alert,
  Card,
  Skeleton,
  theme,
} from 'antd';
import {
  ArrowLeftOutlined,
  SaveOutlined,
  UndoOutlined,
  SyncOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  PartitionOutlined,
  ApartmentOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUpdate, useDelete } from '@api/resource-hooks';
import { fetchDrifts, reconciliationKeys } from '@api/reconciliation-api';
import { useIdentity } from '@api/identity-api';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PageContainer, PageHeader } from '@shared/PageHeader';
import { ErrorState } from '@shared/ErrorState';
import { usePermission } from '../../auth/usePermission';
import { IStandardUser, getUserDisplayName, getUserStatusColor } from '../../interfaces';
import { UserTimeline } from './components/UserTimeline';
import { AccessTab } from './components/AccessTab';
import { DriftTab } from './components/DriftTab';
import { UserRiskTab } from './components/UserRiskTab';
import { UserProfileTab } from './components/UserProfileTab';
import { RawDataTab } from './components/RawDataTab';
import { IdentityCredentialsTab } from '../credential-lifecycle/CredentialListTabs';
import { IdentityRecommendationsTab } from '../intelligence/IdentityRecommendationsTab';
import { resolveIdentityId } from './components/user-detail.types';
import type { IStandardUserWithMeta } from './components/user-detail.types';
import { omitUnchangedPiiFields } from '../../utils/pii-fields';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import { backPath, type FromState } from '../../utils/back-path';
import { IDENTITY_TABS, type IdentityTab } from './identity-path';

const { Text } = Typography;

const CRITICAL_FIELDS = ['departmentName', 'jobTitle', 'location', 'managerEmail'];

/** Golden Record fields the Profile form edits. */
const PROFILE_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'preferredName',
  'email',
  'personalEmail',
  'mobilePhone',
  'workPhone',
  'officeExtension',
  'jobTitle',
  'departmentCode',
  'departmentName',
  'division',
  'costCenter',
  'employeeId',
  'employmentType',
  'managerEmail',
  'location',
  'officeName',
  'city',
  'countryCode',
  'stateProvince',
  'postalCode',
  'timezone',
  'status',
] as const;

function profileValues(user: IStandardUser): Record<string, unknown> {
  const source = user as unknown as Record<string, unknown>;
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f, source[f]]));
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

/**
 * The form values that differ from the identity as loaded: PATCH /identity/:id records every
 * field of its body in the timeline, so unchanged fields stay out. The GitHub login is undefined
 * until edited; an emptied field that was empty before is no change.
 */
function changedProfileValues(
  values: Record<string, unknown>,
  user: IStandardUser,
): Record<string, unknown> {
  const loaded = user as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(values).filter(([field, value]) => {
      if (value === undefined) return false;
      const before = loaded[field];
      if (isEmpty(value) && isEmpty(before)) return false;
      return JSON.stringify(value) !== JSON.stringify(before);
    }),
  );
}

export const IdentityDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { token } = theme.useToken();
  // The App hooks render inside the app's providers; antd's static Modal.confirm and message
  // render in a root of their own, with only the theme handed to them (contexts/color-mode).
  const { message, modal } = App.useApp();
  const canOperate = usePermission('operator');
  const [form] = Form.useForm();
  const { mutate: updateUser, isLoading: isSaving } = useUpdate();
  const { mutate: deleteUser, isLoading: isDeleting } = useDelete();
  const [showSyncWarning, setShowSyncWarning] = useState(false);
  const [changedFields, setChangedFields] = useState<string[]>([]);

  const identityQuery = useIdentity(id);
  const user = identityQuery.data ?? null;
  const identityId = resolveIdentityId(user as IStandardUserWithMeta) ?? id;
  const back = backPath(location.state, '/users');

  const requestedTab = searchParams.get('tab');
  const operatorTabs = ['credentials', 'recommendations'];
  const offered = (tab: string) =>
    (IDENTITY_TABS as readonly string[]).includes(tab) &&
    (!operatorTabs.includes(tab) || canOperate);
  const activeTab: IdentityTab = offered(requestedTab ?? '')
    ? (requestedTab as IdentityTab)
    : 'profile';
  const changeTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'profile') next.delete('tab');
    else next.set('tab', key);
    // Replace, and keep where the page was opened from, so Back still returns there.
    setSearchParams(next, { replace: true, state: location.state });
  };

  // Full identity data: metadata for conflict resolution, sources and provisioning for Raw data
  const { data: identityData } = useQuery({
    queryKey: ['identity', 'v2', 'by-email', user?.email],
    queryFn: async () => {
      if (!user?.email) return null;
      const res = await axiosInstance.get(`${API_BASE}/identity/v2/by-email`, {
        params: { email: user.email },
      });
      return (res.data?.identity ?? null) as IStandardUserWithMeta | null;
    },
    enabled: !!user?.email,
  });

  // Drift count for the tab badge
  const { data: drifts = [] } = useQuery({
    queryKey: reconciliationKeys.drifts({ identityId }),
    queryFn: () => fetchDrifts({ identityId }),
    enabled: !!identityId,
  });
  const driftCount = drifts.length;

  /** Set by a save: the reload that follows loads the saved values into the form. */
  const reloadAfterSave = useRef(false);
  /** The identity as last loaded into the form: what an unsaved edit is measured against. */
  const loadedUser = useRef<IStandardUser | null>(null);
  /** The identity changed while the admin had unsaved edits: Discard loads the new values. */
  const [changedWhileEditing, setChangedWhileEditing] = useState(false);

  // Load the form whenever the identity (re)loads, e.g. after a save. A reload with other data
  // (a real-time event refetches every identity) never overwrites the admin's unsaved edits.
  useEffect(() => {
    if (!user) return;
    const editing =
      loadedUser.current !== null &&
      Object.keys(changedProfileValues(form.getFieldsValue(), loadedUser.current)).length > 0;
    if (editing && !reloadAfterSave.current) {
      queueMicrotask(() => setChangedWhileEditing(true));
      return;
    }
    reloadAfterSave.current = false;
    loadedUser.current = user;
    form.setFieldsValue(profileValues(user));
    queueMicrotask(() => {
      setShowSyncWarning(false);
      setChangedFields([]);
      setChangedWhileEditing(false);
    });
  }, [user, form]);

  /** Re-read this identity and every identity list after a change. */
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['identity'] });
    void queryClient.invalidateQueries({ queryKey: ['resource', 'identity'] });
  };

  // Detect changes to critical fields
  const handleFieldsChange = () => {
    if (!user) return;
    const currentValues = form.getFieldsValue();
    const critical = CRITICAL_FIELDS.filter(
      (field) => currentValues[field] !== user[field as keyof IStandardUser],
    );
    setChangedFields(critical);
    setShowSyncWarning(critical.length > 0);
  };

  const handleDiscard = () => {
    if (!user) return;
    loadedUser.current = user;
    form.setFieldsValue(profileValues(user));
    // Edit-only field (GitHub login): not among the loaded values, so it is cleared separately.
    form.resetFields(['customAttributes']);
    setShowSyncWarning(false);
    setChangedFields([]);
    setChangedWhileEditing(false);
  };

  const handleSave = () => {
    form.validateFields().then(
      (values) => {
        if (!user?._id) {
          message.error('User ID not found');
          return;
        }
        const willTriggerSync = changedFields.length > 0;
        // PII fields hold the API's masked value unless revealed and edited; never send a mask back.
        const changedValues = changedProfileValues(
          omitUnchangedPiiFields(values, user as unknown as Record<string, unknown>),
          user,
        );
        // An unchanged form saves nothing: the identity's timeline gets no empty "Updated" entry
        if (Object.keys(changedValues).length === 0) {
          message.info('No changes to save');
          return;
        }
        updateUser(
          { resource: 'identity', id: user._id, values: changedValues },
          {
            onSuccess: (data) => {
              const responseData = data as { data?: { workflow?: { workflowId?: string } } };
              if (willTriggerSync) {
                message.success({
                  content: (
                    <Space direction="vertical" size={0}>
                      <span>
                        <strong>User updated successfully!</strong>
                      </span>
                      <span style={{ fontSize: '12px' }}>
                        <SyncOutlined spin /> Sync workflow started automatically
                      </span>
                      {responseData?.data?.workflow?.workflowId && (
                        <span style={{ fontSize: '11px', opacity: 0.7 }}>
                          Workflow ID: {responseData.data.workflow.workflowId}
                        </span>
                      )}
                    </Space>
                  ),
                  duration: 5,
                });
              } else {
                message.success('User updated successfully');
              }
              reloadAfterSave.current = true;
              refresh();
            },
            // The API's own message (a refused masked value, say) tells the admin what to fix
            onError: (error) => {
              message.error(`Failed to update user: ${apiErrorMessage(error, 'Unknown error')}`);
            },
          },
        );
      },
      // A failed validation is shown on its field, so its rejection needs no further handling.
      () => undefined,
    );
  };

  const handleDelete = () => {
    const rawId = user?._id;
    if (!rawId) {
      message.error('User ID not found');
      return;
    }
    const userId = String(rawId);

    modal.confirm({
      title: 'Delete user and trigger offboarding?',
      icon: <ExclamationCircleOutlined />,
      content: (
        <Space direction="vertical" size={8}>
          <p>
            Are you sure you want to delete <strong>{getUserDisplayName(user!)}</strong>?
          </p>
          <Alert
            message="Offboarding Workflow"
            description={
              <Space direction="vertical" size={4}>
                <span style={{ fontSize: '12px' }}>
                  This will trigger an offboarding workflow that:
                </span>
                <ul style={{ margin: '4px 0', paddingLeft: '20px', fontSize: '12px' }}>
                  <li>Removes the user from Entra ID</li>
                  <li>Marks the user as DELETED in the Hub</li>
                  <li>Logs all actions for audit trail</li>
                </ul>
              </Space>
            }
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
          />
        </Space>
      ),
      okText: 'Yes, delete user',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: () => {
        deleteUser(
          { resource: 'identity', id: userId },
          {
            onSuccess: (data) => {
              const responseData = data as { data?: { workflowId?: string } };
              message.success({
                content: (
                  <Space direction="vertical" size={0}>
                    <span>
                      <strong>Offboarding workflow started!</strong>
                    </span>
                    <span style={{ fontSize: '12px' }}>User will be removed from Entra ID</span>
                    {responseData?.data?.workflowId && (
                      <span style={{ fontSize: '11px', opacity: 0.7 }}>
                        Workflow ID: {responseData.data.workflowId}
                      </span>
                    )}
                  </Space>
                ),
                duration: 5,
              });
              refresh();
              navigate(back);
            },
            onError: (error) => {
              message.error('Failed to delete user: ' + (error?.message || 'Unknown error'));
            },
          },
        );
      },
    });
  };

  const backButton = (
    <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(back)}>
      Back
    </Button>
  );

  if (!user) {
    return (
      <PageContainer>
        <PageHeader title="Identity" actions={backButton} />
        {identityQuery.isError ? (
          <ErrorState
            title="Could not load this identity"
            error={identityQuery.error}
            onRetry={() => void identityQuery.refetch()}
          />
        ) : (
          <Skeleton active paragraph={{ rows: 8 }} aria-busy aria-label="Loading identity" />
        )}
      </PageContainer>
    );
  }

  const tabItems = [
    {
      key: 'profile',
      label: 'Profile',
      children: (
        <>
          {changedWhileEditing && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="This identity changed while you were editing. Your edits are kept: save them, or Discard to load the new values."
            />
          )}
          <UserProfileTab
            user={user}
            form={form}
            identityId={identityId}
            identityData={identityData ?? null}
            showSyncWarning={showSyncWarning}
            changedFields={changedFields}
            onFieldsChange={handleFieldsChange}
            onSave={refresh}
          />
        </>
      ),
    },
    {
      key: 'access',
      label: 'Access',
      children: identityId ? (
        <AccessTab identityId={identityId} identityEmail={user?.email} />
      ) : (
        <Text type="secondary">Select a user to view entitlements.</Text>
      ),
    },
    ...(canOperate && identityId
      ? [
          {
            key: 'recommendations',
            label: 'Recommendations',
            children: <IdentityRecommendationsTab identityId={identityId} />,
          },
        ]
      : []),
    {
      key: 'drift',
      label:
        driftCount > 0 ? (
          <span>
            Drift <Badge count={driftCount} size="small" />
          </span>
        ) : (
          'Drift'
        ),
      children: identityId ? (
        <DriftTab identityId={identityId} />
      ) : (
        <Text type="secondary">Select a user to view drift.</Text>
      ),
    },
    ...(canOperate && identityId
      ? [
          {
            key: 'credentials',
            label: 'Credentials',
            children: <IdentityCredentialsTab identityId={identityId} />,
          },
        ]
      : []),
    {
      key: 'timeline',
      label: 'Timeline',
      children: user._id ? (
        <UserTimeline userId={user._id} />
      ) : (
        <Text type="secondary">Save the user first to see their timeline.</Text>
      ),
    },
    {
      key: 'risk',
      label: 'Risk',
      children: user._id ? (
        <UserRiskTab user={user} />
      ) : (
        <Text type="secondary">Save the user first to see risk data.</Text>
      ),
    },
    {
      key: 'raw',
      label: 'Raw data',
      children: <RawDataTab user={user} identity={identityData} />,
    },
  ];

  const mapState: FromState = { from: location.pathname + location.search };

  return (
    <PageContainer>
      <PageHeader
        title={getUserDisplayName(user)}
        titleExtra={<Tag color={getUserStatusColor(user.status)}>{user.status}</Tag>}
        subtitle={<span className="mono">{user.email}</span>}
        actions={
          <>
            {backButton}
            <Button
              icon={<PartitionOutlined />}
              onClick={() => navigate(`/identity/${identityId}/map`, { state: mapState })}
              disabled={!identityId}
            >
              Entitlement map
            </Button>
            <Button
              icon={<ApartmentOutlined />}
              onClick={() =>
                navigate(`/access-explorer?identity=${encodeURIComponent(identityId ?? '')}`)
              }
              disabled={!identityId}
            >
              Access graph
            </Button>
            {canOperate && (
              <Button danger icon={<DeleteOutlined />} onClick={handleDelete} loading={isDeleting}>
                Delete user
              </Button>
            )}
          </>
        }
      />
      <Card size="small" role="region" aria-label={`Identity details: ${getUserDisplayName(user)}`}>
        <Tabs items={tabItems} activeKey={activeTab} onChange={changeTab} />
      </Card>
      {activeTab === 'profile' && canOperate && (
        <div
          role="toolbar"
          aria-label="Profile changes"
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 2,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 12,
            padding: '12px 16px',
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            boxShadow: token.boxShadowTertiary,
          }}
        >
          <Button icon={<UndoOutlined />} onClick={handleDiscard} disabled={isSaving}>
            Discard changes
          </Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={isSaving}>
            Save changes
          </Button>
        </div>
      )}
    </PageContainer>
  );
};
