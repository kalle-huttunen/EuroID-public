/**
 * UserProfileTab — identity profile form with drift indicators,
 * field ownership badges, conflict resolution card, and employment contracts. A field an HR
 * source masters is read-only and names its owner (field-mastery.tsx): the API refuses to change
 * it, and the next HR sync would set it back.
 *
 * Owns: drift query, drift correction mutation, conflict resolution mutation.
 * Receives: form instance (parent owns it for footer Save button).
 */

import React, { useEffect, useMemo } from 'react';
import {
  Form,
  Input,
  Select,
  Button,
  Space,
  Tag,
  Typography,
  Alert,
  App,
  Table,
  Card,
  Row,
  Col,
  Collapse,
  Descriptions,
  theme,
} from 'antd';
import { SyncOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchDrifts, correctDrift, reconciliationKeys } from '@api/reconciliation-api';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { IDrift } from '../../../interfaces';
import type { ColumnsType } from 'antd/es/table';
import {
  IStandardUser,
  IEmploymentContract,
  EmploymentType,
  ContractStatus,
  getEmploymentTypeLabel,
} from '../../../interfaces';
import { DriftIndicator } from '@shared/DriftIndicator';
import { PiiInput } from '@shared/PiiField';
import type {
  IStandardUserWithMeta,
  IdentityMetadata,
  IdentitySnapshot,
  DriftMapEntry,
} from './user-detail.types';
import { resolveIdentityId } from './user-detail.types';
import { apiErrorMessage } from '../../dead-letter/dead-letter-labels';
import { GitHubLoginInput } from './GitHubLoginInput';
import { validateGitHubLogin } from './github-login';
import { useFieldMastery } from './field-mastery';

const { Title, Text } = Typography;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ConflictCard: React.FC<{
  conflictDetails: NonNullable<IdentityMetadata['conflictDetails']>;
  onResolve: (action: 'merge' | 'split' | 'dismiss') => void;
  isPending: boolean;
}> = ({ conflictDetails, onResolve, isPending }) => {
  const { token } = theme.useToken();
  const renderSnapshot = (title: string, snapshot?: IdentitySnapshot) => (
    <Card title={title} size="small">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="Source">{snapshot?.sourceName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Name">
          {snapshot?.firstName} {snapshot?.lastName || '—'}
        </Descriptions.Item>
        <Descriptions.Item label="Email">{snapshot?.email ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Department">{snapshot?.departmentName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Job Title">{snapshot?.jobTitle ?? '—'}</Descriptions.Item>
      </Descriptions>
    </Card>
  );

  return (
    <Card
      title={
        <Space>
          <WarningOutlined style={{ color: token.colorWarning }} />
          Identity Correlation Conflict
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="Matched By" span={2}>
          {conflictDetails.matchedBy}
          {conflictDetails.matchedValue != null && ` (${conflictDetails.matchedValue})`}
          {conflictDetails.confidence != null && (
            <Text type="secondary" style={{ marginLeft: 8 }}>
              — confidence: {Math.round((conflictDetails.confidence as number) * 100)}%
            </Text>
          )}
        </Descriptions.Item>
      </Descriptions>
      {/* Side by side from md up; stacked on phones, where half a card broke words per letter. */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={12}>
          {renderSnapshot('Existing Record', conflictDetails.existingSnapshot)}
        </Col>
        <Col xs={24} md={12}>
          {renderSnapshot('Incoming Record', conflictDetails.incomingSnapshot)}
        </Col>
      </Row>
      <Space wrap style={{ marginTop: 16 }}>
        <Button type="primary" onClick={() => onResolve('merge')} loading={isPending}>
          Merge — Same Person
        </Button>
        <Button onClick={() => onResolve('split')} loading={isPending}>
          Split — Different People
        </Button>
        <Button onClick={() => onResolve('dismiss')} loading={isPending}>
          Dismiss
        </Button>
      </Space>
    </Card>
  );
};

const SyncWarningAlert: React.FC<{ changedFields: string[] }> = ({ changedFields }) => {
  const FIELD_LABELS: Record<string, string> = {
    departmentName: 'Department',
    jobTitle: 'Job Title',
    location: 'Location',
    managerEmail: 'Manager',
  };

  return (
    <Alert
      message="Automatic Sync to Entra ID"
      description={
        <Space direction="vertical" size={4}>
          <span>
            The following critical fields have changed and will automatically trigger a sync to
            Entra ID:
          </span>
          <Space wrap size={4}>
            {changedFields.map((field) => (
              <Tag key={field} color="blue" icon={<SyncOutlined />}>
                {FIELD_LABELS[field] ?? field}
              </Tag>
            ))}
          </Space>
          <span style={{ fontSize: '12px', opacity: 0.8 }}>
            This ensures groups, licenses, and attributes are updated in real-time.
          </span>
        </Space>
      }
      type="info"
      showIcon
      icon={<InfoCircleOutlined />}
      style={{ marginBottom: 16 }}
    />
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface UserProfileTabProps {
  user: IStandardUser;
  form: FormInstance;
  identityId: string | undefined;
  identityData: IStandardUserWithMeta | null;
  showSyncWarning: boolean;
  changedFields: string[];
  onFieldsChange: () => void;
  /** After a conflict is resolved: refresh what shows the identity. */
  onSave?: () => void;
  /** After a conflict is resolved, when the host closes (the identity page stays open). */
  onClose?: () => void;
}

export const UserProfileTab: React.FC<UserProfileTabProps> = ({
  user,
  form,
  identityId,
  identityData,
  showSyncWarning,
  changedFields,
  onFieldsChange,
  onSave,
  onClose,
}) => {
  const queryClient = useQueryClient();
  // App.useApp's modal and message follow the app's theme; the static ones render outside it.
  const { modal, message } = App.useApp();

  // The GitHub login field holds edits only: a (re)loaded identity starts it unedited
  useEffect(() => {
    form.resetFields(['customAttributes']);
  }, [user, form]);

  // --- Drift data ---
  const { data: drifts = [] } = useQuery({
    queryKey: reconciliationKeys.drifts({ identityId }),
    queryFn: () => fetchDrifts({ identityId }),
    enabled: !!identityId,
  });

  const driftMap = useMemo(() => {
    const map: Record<string, DriftMapEntry> = {};
    drifts.forEach((d: IDrift) => {
      if (d.field) {
        map[d.field] = {
          actualValue: d.targetValue,
          connector: d.targetSystem,
          driftId: d.id,
          autoCorrectEligible: d.autoCorrectEligible,
        };
      }
    });
    return map;
  }, [drifts]);

  const correctMutation = useMutation({
    mutationFn: correctDrift,
    onSuccess: () => {
      // Every drift list (badge, Drift tab, map, Reconciliation page): the drift leaves them all.
      queryClient.invalidateQueries({ queryKey: reconciliationKeys.driftsPrefix() });
      message.success('Drift correction initiated');
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to correct drift'));
    },
  });

  // --- Conflict resolution ---
  const userWithMeta = user as IStandardUserWithMeta;
  const hasConflict =
    userWithMeta?.metadata?.requiresReview ??
    userWithMeta?.metadata?.correlationConflict ??
    identityData?.metadata?.requiresReview ??
    identityData?.metadata?.correlationConflict;
  const conflictDetails =
    userWithMeta?.metadata?.conflictDetails ?? identityData?.metadata?.conflictDetails;
  const conflictIdentityId = identityData?._id ?? user?._id;

  const resolveConflictMutation = useMutation({
    mutationFn: async (action: 'merge' | 'split' | 'dismiss') => {
      const id = conflictIdentityId ?? identityId;
      if (!id) throw new Error('Identity ID required');
      await axiosInstance.post(`${API_BASE}/identity/${id}/resolve-conflict`, { action });
    },
    onSuccess: (_, action) => {
      message.success(`Conflict resolved: ${action}`);
      queryClient.invalidateQueries({ queryKey: ['identity', 'conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['identity', 'v2', 'by-email', user?.email] });
      onSave?.();
      onClose?.();
    },
    // A refused merge (409) changed nothing; its message says why and what to do. The toast is
    // not returned: React Query would keep the mutation pending until it closes.
    onError: (err) => {
      message.error(apiErrorMessage(err, 'Failed to resolve conflict'));
    },
  });

  const handleResolveConflict = (action: 'merge' | 'split' | 'dismiss') => {
    const dialogs: Record<string, { title: string; content: string }> = {
      merge: {
        title: 'Merge — Same Person',
        content:
          "This will combine both records into one identity. The incoming source will be added to this identity's sources. Continue?",
      },
      split: {
        title: 'Split — Different People',
        content:
          'This will keep both identities separate. The incoming record will remain as a standalone identity. Continue?',
      },
      dismiss: {
        title: 'Dismiss Conflict',
        content:
          'This will clear the conflict flag. No changes will be made to either identity. Continue?',
      },
    };
    const { title, content } = dialogs[action];
    modal.confirm({
      title,
      content,
      okText: 'Continue',
      cancelText: 'Cancel',
      onOk: () => resolveConflictMutation.mutate(action),
    });
  };

  // --- Field mastery: a field an HR source masters is read-only and names its owner ---
  const mastery = useFieldMastery(identityId);

  // --- Drift indicator helper ---
  const driftProps = (field: string, expectedValue?: string) => ({
    field,
    isSynced: !driftMap[field],
    expectedValue,
    actualValue: driftMap[field]?.actualValue,
    connector: driftMap[field]?.connector,
    onFix:
      driftMap[field]?.driftId && driftMap[field]?.autoCorrectEligible
        ? () => correctMutation.mutate(driftMap[field]!.driftId!)
        : undefined,
  });

  // --- Employments columns ---
  const employmentsColumns: ColumnsType<IEmploymentContract> = [
    { title: 'Title', dataIndex: 'title', key: 'title', width: 180 },
    { title: 'Department', dataIndex: 'department', key: 'department', width: 160 },
    {
      title: 'Primary',
      dataIndex: 'isPrimary',
      key: 'isPrimary',
      width: 100,
      render: (isPrimary: boolean) => (isPrimary ? <Tag color="blue">Primary</Tag> : null),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: ContractStatus) => (
        <Tag color={status === ContractStatus.ACTIVE ? 'green' : 'default'}>{status}</Tag>
      ),
    },
  ];

  return (
    <>
      {hasConflict && conflictDetails && (
        <ConflictCard
          conflictDetails={conflictDetails}
          onResolve={handleResolveConflict}
          isPending={resolveConflictMutation.isPending}
        />
      )}

      {showSyncWarning && <SyncWarningAlert changedFields={changedFields} />}

      <Form form={form} layout="vertical" style={{ maxWidth: 600 }} onFieldsChange={onFieldsChange}>
        {/* Read-only fields */}
        <Form.Item label="Source System">
          <Input value={user?.sourceSystem || 'Manual'} disabled />
        </Form.Item>
        <Form.Item label="Source User ID">
          <Input value={user?.sourceUserId} disabled />
        </Form.Item>

        {/* Personal Information */}
        <Title level={5}>Personal Information</Title>
        <Form.Item
          label={
            <span>
              First Name
              {mastery.badge('firstName')}
              <DriftIndicator {...driftProps('firstName', user?.firstName)} />
            </span>
          }
          name="firstName"
          {...mastery.itemProps('firstName')}
          rules={[{ required: true, message: 'First name is required' }]}
        >
          <Input disabled={mastery.isReadOnly('firstName')} />
        </Form.Item>
        <Form.Item label="Middle Name" name="middleName" {...mastery.itemProps('middleName')}>
          <Input disabled={mastery.isReadOnly('middleName')} />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Last Name
              {mastery.badge('lastName')}
              <DriftIndicator {...driftProps('lastName', user?.lastName)} />
            </span>
          }
          name="lastName"
          {...mastery.itemProps('lastName')}
          rules={[{ required: true, message: 'Last name is required' }]}
        >
          <Input disabled={mastery.isReadOnly('lastName')} />
        </Form.Item>
        <Form.Item
          label="Preferred Name"
          name="preferredName"
          {...mastery.itemProps('preferredName')}
        >
          <Input
            placeholder="How the user prefers to be called"
            disabled={mastery.isReadOnly('preferredName')}
          />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Email
              {mastery.badge('email')}
              <DriftIndicator {...driftProps('email', user?.email)} />
            </span>
          }
          name="email"
          {...mastery.itemProps('email')}
          rules={[
            { required: true, message: 'Email is required' },
            { type: 'email', message: 'Invalid email format' },
          ]}
        >
          <Input disabled={mastery.isReadOnly('email')} />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Personal Email
              {mastery.badge('personalEmail')}
            </span>
          }
          name="personalEmail"
          {...mastery.itemProps('personalEmail')}
        >
          <PiiInput
            label="Personal Email"
            identityId={identityId}
            field="personalEmail"
            disabled={mastery.isReadOnly('personalEmail')}
          />
        </Form.Item>

        {/* Contact Information */}
        <Title level={5}>Contact Information</Title>
        <Form.Item
          label={
            <span>
              Mobile Phone
              {mastery.badge('mobilePhone')}
            </span>
          }
          name="mobilePhone"
          {...mastery.itemProps('mobilePhone')}
        >
          <PiiInput
            label="Mobile Phone"
            identityId={identityId}
            field="mobilePhone"
            disabled={mastery.isReadOnly('mobilePhone')}
          />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Work Phone
              {mastery.badge('workPhone')}
            </span>
          }
          name="workPhone"
          {...mastery.itemProps('workPhone')}
        >
          <PiiInput
            label="Work Phone"
            identityId={identityId}
            field="workPhone"
            disabled={mastery.isReadOnly('workPhone')}
          />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Office Extension
              {mastery.badge('officeExtension')}
            </span>
          }
          name="officeExtension"
          {...mastery.itemProps('officeExtension')}
        >
          <PiiInput
            label="Office Extension"
            identityId={identityId}
            field="officeExtension"
            disabled={mastery.isReadOnly('officeExtension')}
          />
        </Form.Item>

        {/* Employment Information */}
        <Title level={5}>Employment Information</Title>
        <Form.Item
          label={
            <span>
              Job Title
              {mastery.badge('jobTitle')}
              <DriftIndicator {...driftProps('jobTitle', user?.jobTitle)} />
            </span>
          }
          name="jobTitle"
          {...mastery.itemProps('jobTitle')}
        >
          <Input disabled={mastery.isReadOnly('jobTitle')} />
        </Form.Item>
        <Form.Item
          label="Department Code"
          name="departmentCode"
          {...mastery.itemProps('departmentCode')}
        >
          <Input disabled={mastery.isReadOnly('departmentCode')} />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Department Name
              {mastery.badge('departmentName')}
              <DriftIndicator {...driftProps('departmentName', user?.departmentName)} />
            </span>
          }
          name="departmentName"
          {...mastery.itemProps('departmentName')}
        >
          <Input disabled={mastery.isReadOnly('departmentName')} />
        </Form.Item>
        <Form.Item label="Division" name="division" {...mastery.itemProps('division')}>
          <Input disabled={mastery.isReadOnly('division')} />
        </Form.Item>
        <Form.Item label="Cost Center" name="costCenter" {...mastery.itemProps('costCenter')}>
          <Input disabled={mastery.isReadOnly('costCenter')} />
        </Form.Item>
        <Form.Item label="Employee ID" name="employeeId" {...mastery.itemProps('employeeId')}>
          <Input disabled={mastery.isReadOnly('employeeId')} />
        </Form.Item>
        <Form.Item
          label="Employment Type"
          name="employmentType"
          {...mastery.itemProps('employmentType')}
        >
          <Select allowClear disabled={mastery.isReadOnly('employmentType')}>
            <Select.Option value={EmploymentType.FULL_TIME}>
              {getEmploymentTypeLabel(EmploymentType.FULL_TIME)}
            </Select.Option>
            <Select.Option value={EmploymentType.PART_TIME}>
              {getEmploymentTypeLabel(EmploymentType.PART_TIME)}
            </Select.Option>
            <Select.Option value={EmploymentType.CONTRACTOR}>
              {getEmploymentTypeLabel(EmploymentType.CONTRACTOR)}
            </Select.Option>
            <Select.Option value={EmploymentType.INTERN}>
              {getEmploymentTypeLabel(EmploymentType.INTERN)}
            </Select.Option>
            <Select.Option value={EmploymentType.CONSULTANT}>
              {getEmploymentTypeLabel(EmploymentType.CONSULTANT)}
            </Select.Option>
          </Select>
        </Form.Item>
        <Form.Item label="Manager Email" name="managerEmail" {...mastery.itemProps('managerEmail')}>
          <Input disabled={mastery.isReadOnly('managerEmail')} />
        </Form.Item>

        {/* Location Information */}
        <Title level={5}>Location Information</Title>
        <Form.Item label="Location" name="location" {...mastery.itemProps('location')}>
          <Input disabled={mastery.isReadOnly('location')} />
        </Form.Item>
        <Form.Item label="Office Name" name="officeName" {...mastery.itemProps('officeName')}>
          <Input disabled={mastery.isReadOnly('officeName')} />
        </Form.Item>
        <Form.Item label="City" name="city" {...mastery.itemProps('city')}>
          <Input disabled={mastery.isReadOnly('city')} />
        </Form.Item>
        <Form.Item
          label="State/Province"
          name="stateProvince"
          {...mastery.itemProps('stateProvince')}
        >
          <Input disabled={mastery.isReadOnly('stateProvince')} />
        </Form.Item>
        <Form.Item label="Country Code" name="countryCode" {...mastery.itemProps('countryCode')}>
          <Input placeholder="e.g., US, GB, DE" disabled={mastery.isReadOnly('countryCode')} />
        </Form.Item>
        <Form.Item label="Postal Code" name="postalCode" {...mastery.itemProps('postalCode')}>
          <Input disabled={mastery.isReadOnly('postalCode')} />
        </Form.Item>
        <Form.Item label="Timezone" name="timezone" {...mastery.itemProps('timezone')}>
          <Input placeholder="e.g., America/New_York" disabled={mastery.isReadOnly('timezone')} />
        </Form.Item>

        {/* System Attributes */}
        <Title level={5}>System Attributes</Title>
        <Form.Item label="Status" name="status" {...mastery.itemProps('status')}>
          <Select disabled={mastery.isReadOnly('status')}>
            <Select.Option value="ACTIVE">Active</Select.Option>
            <Select.Option value="INACTIVE">Inactive</Select.Option>
            <Select.Option value="PENDING">Pending</Select.Option>
            <Select.Option value="SUSPENDED">Suspended</Select.Option>
            <Select.Option value="TERMINATED">Terminated</Select.Option>
            <Select.Option value="GUEST">Guest</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item
          label="GitHub login"
          name="customAttributes"
          rules={[{ validator: validateGitHubLogin }]}
          extra="Optional. With it, onboarding invites this GitHub account and offboarding removes it from the organization; without it, GitHub is invited by email."
        >
          <GitHubLoginInput current={user?.customAttributes} />
        </Form.Item>
      </Form>

      {/* Employment Contracts */}
      <Collapse
        style={{ marginTop: 24 }}
        items={[
          {
            key: 'employments',
            label: 'Employment Contracts',
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                  All employment contracts (personas). The primary contract drives the root Job
                  Title and Department.
                </Text>
                {user?.contracts && user.contracts.length > 0 ? (
                  <Table<IEmploymentContract>
                    size="small"
                    rowKey="id"
                    pagination={false}
                    dataSource={user.contracts}
                    columns={employmentsColumns}
                    onRow={(record) =>
                      record.isPrimary
                        ? { style: { backgroundColor: 'var(--ant-color-primary-bg)' } }
                        : {}
                    }
                  />
                ) : (
                  <Text type="secondary">
                    No employment contracts. Add contracts via HR feed or API to enable multi-role
                    support.
                  </Text>
                )}
              </>
            ),
          },
        ]}
      />
    </>
  );
};
