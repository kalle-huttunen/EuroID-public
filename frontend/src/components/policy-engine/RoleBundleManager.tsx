/**
 * RoleBundleManager - Pre-configured Role Templates
 *
 * Manage reusable role bundles (Standard Employee, Sales User, IT Admin, etc.)
 * that can be quick-applied to policies. Like "templates" for common access patterns.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  App,
  Card,
  Space,
  Tag,
  Typography,
  Button,
  Row,
  Col,
  Tooltip,
  Modal,
  Form,
  Input,
  Select,
  Collapse,
  Empty,
  Popconfirm,
  Spin,
  Alert,
  Dropdown,
  theme,
} from 'antd';
import {
  UserOutlined,
  DollarOutlined,
  ToolOutlined,
  ClockCircleOutlined,
  CrownOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  ApartmentOutlined,
  SafetyCertificateOutlined,
  CloudOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { useList, useCreate, useUpdate, useDelete } from '@api/resource-hooks';
import { RoleBundle, AVAILABLE_ACTIONS, ActionTarget } from './types';
import { LicenseSkuSelect } from './LicenseSkuSelect';
import { usePermission } from '../../auth/usePermission';
import { apiErrorMessage } from '../../features/dead-letter/dead-letter-labels';
import { BRAND, SEMANTIC } from '../../theme';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

const CATALOG_API = `${API_BASE}/entitlement-catalog`;

interface CatalogGroup {
  name: string;
  nativeId: string;
  system: string;
}

interface CatalogRole {
  name: string;
  nativeId: string;
  system: string;
  adminTier?: string;
}

const { Text } = Typography;

interface Props {
  onApplyBundle: (bundle: RoleBundle) => void;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  UserOutlined: <UserOutlined />,
  DollarOutlined: <DollarOutlined />,
  ToolOutlined: <ToolOutlined />,
  ClockCircleOutlined: <ClockCircleOutlined />,
  CrownOutlined: <CrownOutlined />,
};

const getTargetLabel = (target: ActionTarget) => {
  const map: Record<string, string> = {
    'active-directory': 'AD',
    'entra-id': 'Entra',
    salesforce: 'SF',
    all: 'All',
  };
  return map[target] || target;
};

/** Check if adding inheritance would create a cycle (parent chain leads back to current bundle) */
function hasCircularDependency(
  currentId: string,
  inheritance: string[],
  bundles: RoleBundle[],
): boolean {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === currentId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const b = byId.get(id);
    const parents = b?.inheritance ?? [];
    return parents.some((p) => visit(p));
  };
  return inheritance.some((parentId) => visit(parentId));
}

export const RoleBundleManager: React.FC<Props> = ({ onApplyBundle }) => {
  const { token } = theme.useToken();
  const getTargetIcon = (target: ActionTarget) => {
    const map: Record<string, React.ReactNode> = {
      'active-directory': <ApartmentOutlined style={{ color: token.colorPrimary }} />,
      'entra-id': <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />,
      salesforce: <CloudOutlined style={{ color: token.colorInfo }} />,
      all: <AppstoreOutlined />,
    };
    return map[target] || null;
  };
  // Create, edit, duplicate and delete need policy-admin; Apply serves a policy being authored
  const canEdit = usePermission('policy-admin');
  const { message } = App.useApp();
  /** A refused save, duplicate or delete (400, 403) says why; the modal or card stays. */
  const onError = (action: string) => (err: unknown) =>
    message.error(`${action}: ${apiErrorMessage(err, 'the request failed')}`);
  const { data: listData, isLoading } = useList<RoleBundle>({ resource: 'role-bundles' });
  const bundles: RoleBundle[] = listData?.data ?? [];
  const { mutate: createMutate, isLoading: creating } = useCreate();
  const { mutate: updateMutate, isLoading: updating } = useUpdate();
  const { mutate: deleteMutate } = useDelete();

  const [editingBundle, setEditingBundle] = useState<RoleBundle | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [catalogGroups, setCatalogGroups] = useState<CatalogGroup[]>([]);
  const [catalogRoles, setCatalogRoles] = useState<CatalogRole[]>([]);

  const fetchCatalog = useCallback(() => {
    Promise.all([
      axiosInstance.get(CATALOG_API, { params: { system: 'entra-id', type: 'Group' } }),
      axiosInstance.get(CATALOG_API, { params: { system: 'ad', type: 'Group' } }),
      axiosInstance.get(CATALOG_API, { params: { system: 'entra-id', type: 'DirectoryRole' } }),
    ])
      .then(([entraRes, adRes, rolesRes]) => {
        const entraGroups = (entraRes.data.entitlements ?? []).map(
          (e: { name: string; nativeId?: string }) => ({
            name: e.name,
            nativeId: e.nativeId ?? e.name,
            system: 'entra-id',
          }),
        );
        const adGroups = (adRes.data.entitlements ?? []).map(
          (e: { name: string; nativeId?: string }) => ({
            name: e.name,
            nativeId: e.nativeId ?? e.name,
            system: 'ad',
          }),
        );
        const roles = (rolesRes.data.entitlements ?? []).map(
          (e: { name: string; nativeId?: string; adminTier?: string }) => ({
            name: e.name,
            nativeId: e.nativeId ?? e.name,
            system: 'entra-id',
            adminTier: e.adminTier,
          }),
        );
        setCatalogGroups([...entraGroups, ...adGroups]);
        setCatalogRoles(roles);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (modalVisible) fetchCatalog();
  }, [modalVisible, fetchCatalog]);

  const handleCreateBundle = () => {
    setEditingBundle({
      id: '',
      name: '',
      description: '',
      icon: 'UserOutlined',
      color: BRAND.primary,
      actions: [],
      inheritance: [],
      tags: [],
      usedByPolicies: 0,
    });
    setModalVisible(true);
  };

  const handleEditBundle = (bundle: RoleBundle) => {
    setEditingBundle({ ...bundle, inheritance: bundle.inheritance ?? [] });
    setModalVisible(true);
  };

  const handleDeleteBundle = (bundleId: string) => {
    deleteMutate(
      { resource: 'role-bundles', id: bundleId },
      { onError: onError('Could not delete the bundle') },
    );
  };

  const handleDuplicateBundle = (bundle: RoleBundle) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...rest } = bundle;
    createMutate(
      { resource: 'role-bundles', values: { ...rest, name: `${bundle.name} (Copy)` } },
      {
        onSuccess: () => setModalVisible(false),
        onError: onError('Could not duplicate the bundle'),
      },
    );
  };

  const handleSaveBundle = () => {
    if (!editingBundle) return;
    const inheritance = editingBundle.inheritance ?? [];
    const circular =
      editingBundle.id && hasCircularDependency(editingBundle.id, inheritance, bundles);
    if (circular) return; // Block save when circular dependency detected
    const { id, ...payload } = editingBundle;
    if (id) {
      updateMutate(
        { resource: 'role-bundles', id, values: payload },
        {
          onSuccess: () => {
            setModalVisible(false);
            setEditingBundle(null);
          },
          onError: onError('Could not save the bundle'),
        },
      );
    } else {
      createMutate(
        { resource: 'role-bundles', values: payload },
        {
          onSuccess: () => {
            setModalVisible(false);
            setEditingBundle(null);
          },
          onError: onError('Could not save the bundle'),
        },
      );
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <ThunderboltOutlined style={{ color: token.colorPrimary }} />
          <Text strong>Role Bundles</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Pre-configured access templates
          </Text>
        </Space>
        {canEdit && (
          <Button size="small" icon={<PlusOutlined />} onClick={handleCreateBundle}>
            New Bundle
          </Button>
        )}
      </div>

      {/* Bundle Grid */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="Loading role bundles…">
            <div style={{ minHeight: 100 }} />
          </Spin>
        </div>
      ) : (
        <Row gutter={[12, 12]}>
          {bundles.map((bundle) => (
            <Col key={bundle.id} span={12}>
              <Card
                size="small"
                hoverable
                style={{
                  borderLeft: `4px solid ${bundle.color}`,
                  transition: 'all 0.2s',
                }}
                bodyStyle={{ padding: 12 }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {/* Bundle Header */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                    }}
                  >
                    <Space>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          background: `${bundle.color}15`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: bundle.color,
                          fontSize: 16,
                        }}
                      >
                        {ICON_MAP[bundle.icon] || <UserOutlined />}
                      </div>
                      <div>
                        <Text strong style={{ fontSize: 13 }}>
                          {bundle.name}
                        </Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          {bundle.description.length > 60
                            ? `${bundle.description.slice(0, 60)}...`
                            : bundle.description}
                        </Text>
                      </div>
                    </Space>
                  </div>

                  {/* Actions Summary */}
                  <div>
                    <Space size={4} wrap>
                      {bundle.actions.map((action) => {
                        const actionDef = AVAILABLE_ACTIONS.find((a) => a.value === action.type);
                        return (
                          <Tooltip
                            key={action.id}
                            title={`${actionDef?.label || action.type} → ${action.target}`}
                          >
                            <Tag
                              style={{ fontSize: 10, lineHeight: '16px', cursor: 'default' }}
                              icon={getTargetIcon(action.target)}
                            >
                              {getTargetLabel(action.target)}:{' '}
                              {action.params.groupName ||
                                action.params.roleName ||
                                action.params.licenseSku ||
                                action.params.mfaMethod ||
                                action.params.policyName ||
                                actionDef?.label}
                            </Tag>
                          </Tooltip>
                        );
                      })}
                    </Space>
                  </div>

                  {/* Footer */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      borderTop: `1px solid ${token.colorBorderSecondary}`,
                      paddingTop: 8,
                    }}
                  >
                    <Space size={4}>
                      <Text type="secondary" style={{ fontSize: 10 }}>
                        {bundle.actions.length} actions
                      </Text>
                      {(bundle.usedByPolicies ?? 0) > 0 && (
                        <Tag style={{ fontSize: 9, lineHeight: '14px' }}>
                          Used by {bundle.usedByPolicies}{' '}
                          {bundle.usedByPolicies === 1 ? 'policy' : 'policies'}
                        </Tag>
                      )}
                    </Space>
                    {canEdit && (
                      <Space size={4}>
                        <Tooltip title="Apply to current policy">
                          <Button
                            type="primary"
                            size="small"
                            icon={<CheckCircleOutlined />}
                            onClick={() => onApplyBundle(bundle)}
                            style={{ fontSize: 11, height: 24 }}
                          >
                            Apply
                          </Button>
                        </Tooltip>
                        <Button
                          type="text"
                          size="small"
                          aria-label="Edit role bundle"
                          icon={<EditOutlined />}
                          onClick={() => handleEditBundle(bundle)}
                        />
                        <Button
                          type="text"
                          size="small"
                          aria-label="Duplicate role bundle"
                          icon={<CopyOutlined />}
                          onClick={() => handleDuplicateBundle(bundle)}
                        />
                        <Popconfirm
                          title="Delete this bundle?"
                          onConfirm={() => handleDeleteBundle(bundle.id)}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            aria-label="Delete role bundle"
                            icon={<DeleteOutlined />}
                          />
                        </Popconfirm>
                      </Space>
                    )}
                  </div>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {!isLoading && bundles.length === 0 && (
        <Empty description="No role bundles configured. Create one to speed up policy creation." />
      )}

      {/* Edit/Create Modal */}
      <Modal
        title={editingBundle?.name ? `Edit: ${editingBundle.name}` : 'Create Role Bundle'}
        open={modalVisible}
        onOk={handleSaveBundle}
        onCancel={() => {
          setModalVisible(false);
          setEditingBundle(null);
        }}
        okText={editingBundle?.name ? 'Save Changes' : 'Create Bundle'}
        confirmLoading={creating || updating}
        width={600}
      >
        {editingBundle && (
          <Form layout="vertical" size="small">
            <Form.Item label="Bundle Name" required>
              <Input
                value={editingBundle.name}
                onChange={(e) => setEditingBundle({ ...editingBundle, name: e.target.value })}
                placeholder="e.g. Standard Employee"
              />
            </Form.Item>
            <Form.Item label="Description">
              <Input.TextArea
                value={editingBundle.description}
                onChange={(e) =>
                  setEditingBundle({ ...editingBundle, description: e.target.value })
                }
                placeholder="What access does this bundle grant?"
                rows={2}
              />
            </Form.Item>
            <Form.Item
              label="Parent Bundles"
              help="Inherit actions from other bundles. First in list takes precedence for duplicates."
            >
              <Select
                mode="multiple"
                placeholder="Select parent bundles..."
                value={editingBundle.inheritance ?? []}
                onChange={(val) => setEditingBundle({ ...editingBundle, inheritance: val })}
                options={bundles
                  .filter((b) => b.id !== editingBundle.id)
                  .map((b) => ({ value: b.id, label: b.name }))}
                allowClear
                style={{ width: '100%' }}
              />
            </Form.Item>
            {editingBundle.id &&
              hasCircularDependency(editingBundle.id, editingBundle.inheritance ?? [], bundles) && (
                <Alert
                  type="warning"
                  message="Circular dependency detected"
                  description="One or more parent bundles would create a cycle. Remove them to save."
                  showIcon
                  style={{ marginBottom: 16 }}
                />
              )}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="Icon">
                  <Select
                    value={editingBundle.icon}
                    onChange={(val) => setEditingBundle({ ...editingBundle, icon: val })}
                    options={[
                      {
                        value: 'UserOutlined',
                        label: (
                          <Space>
                            <UserOutlined /> Standard User
                          </Space>
                        ),
                      },
                      {
                        value: 'DollarOutlined',
                        label: (
                          <Space>
                            <DollarOutlined /> Sales
                          </Space>
                        ),
                      },
                      {
                        value: 'ToolOutlined',
                        label: (
                          <Space>
                            <ToolOutlined /> IT/Admin
                          </Space>
                        ),
                      },
                      {
                        value: 'ClockCircleOutlined',
                        label: (
                          <Space>
                            <ClockCircleOutlined /> Temporary
                          </Space>
                        ),
                      },
                      {
                        value: 'CrownOutlined',
                        label: (
                          <Space>
                            <CrownOutlined /> Executive
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="Color">
                  <Select
                    value={editingBundle.color}
                    onChange={(val) => setEditingBundle({ ...editingBundle, color: val })}
                    options={[
                      {
                        value: '#1890ff',
                        label: (
                          <Space>
                            <div
                              style={{
                                width: 12,
                                height: 12,
                                background: '#1890ff',
                                borderRadius: 2,
                              }}
                            />{' '}
                            Blue
                          </Space>
                        ),
                      },
                      {
                        value: '#52c41a',
                        label: (
                          <Space>
                            <div
                              style={{
                                width: 12,
                                height: 12,
                                background: '#52c41a',
                                borderRadius: 2,
                              }}
                            />{' '}
                            Green
                          </Space>
                        ),
                      },
                      {
                        value: '#722ed1',
                        label: (
                          <Space>
                            <div
                              style={{
                                width: 12,
                                height: 12,
                                background: '#722ed1',
                                borderRadius: 2,
                              }}
                            />{' '}
                            Purple
                          </Space>
                        ),
                      },
                      {
                        value: '#faad14',
                        label: (
                          <Space>
                            <div
                              style={{
                                width: 12,
                                height: 12,
                                background: '#faad14',
                                borderRadius: 2,
                              }}
                            />{' '}
                            Gold
                          </Space>
                        ),
                      },
                      {
                        value: '#eb2f96',
                        label: (
                          <Space>
                            <div
                              style={{
                                width: 12,
                                height: 12,
                                background: '#eb2f96',
                                borderRadius: 2,
                              }}
                            />{' '}
                            Pink
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Collapse ghost>
              <Collapse.Panel
                header={
                  <Space>
                    <Text strong>Actions ({editingBundle.actions.length})</Text>
                  </Space>
                }
                key="actions"
              >
                <Space direction="vertical" style={{ width: '100%' }}>
                  {editingBundle.actions.map((action) => {
                    const actionDef = AVAILABLE_ACTIONS.find((a) => a.value === action.type);
                    const TARGET_TO_SYSTEM: Record<string, string> = {
                      'entra-id': 'entra-id',
                      'active-directory': 'ad',
                    };
                    const catalogSystem = TARGET_TO_SYSTEM[action.target] ?? action.target;
                    const systemGroups = catalogGroups.filter((g) => g.system === catalogSystem);
                    const tierColor = (tier: string | undefined) => {
                      if (tier === 'TIER_0') return SEMANTIC.statusError;
                      if (tier === 'TIER_1') return SEMANTIC.statusDriftText;
                      if (tier === 'TIER_2') return BRAND.warningText;
                      return undefined;
                    };
                    const updateActionParams = (updates: Record<string, string>) =>
                      setEditingBundle({
                        ...editingBundle,
                        actions: editingBundle.actions.map((a) =>
                          a.id === action.id ? { ...a, params: { ...a.params, ...updates } } : a,
                        ),
                      });
                    return (
                      <Row
                        key={action.id}
                        gutter={4}
                        align="middle"
                        style={{
                          background: token.colorFillQuaternary,
                          padding: 6,
                          borderRadius: 4,
                        }}
                      >
                        <Col flex="auto">
                          <Space size={4} wrap>
                            <Select
                              value={action.target}
                              onChange={(val) =>
                                setEditingBundle({
                                  ...editingBundle,
                                  actions: editingBundle.actions.map((a) =>
                                    a.id === action.id ? { ...a, target: val as ActionTarget } : a,
                                  ),
                                })
                              }
                              size="small"
                              style={{ width: 100 }}
                              options={
                                action.type === 'assign_role'
                                  ? [{ value: 'entra-id', label: 'Entra ID' }]
                                  : [
                                      { value: 'entra-id', label: 'Entra ID' },
                                      { value: 'active-directory', label: 'AD' },
                                    ]
                              }
                            />
                            <Tag>{actionDef?.label}</Tag>
                            {action.type === 'assign_group' && (
                              <Select
                                value={action.params.groupName}
                                placeholder="Select group..."
                                size="small"
                                style={{ minWidth: 160 }}
                                showSearch
                                optionFilterProp="label"
                                options={systemGroups.map((g) => ({
                                  value: g.nativeId,
                                  label: g.name,
                                }))}
                                onChange={(val) => updateActionParams({ groupName: val })}
                                notFoundContent={systemGroups.length === 0 ? 'Run discovery' : null}
                              />
                            )}
                            {action.type === 'assign_license' && (
                              <LicenseSkuSelect
                                value={action.params.licenseSku as string | undefined}
                                onChange={(val) => updateActionParams({ licenseSku: val })}
                                minWidth={140}
                              />
                            )}
                            {action.type === 'assign_role' && (
                              <Select
                                value={action.params.roleTemplateId}
                                placeholder="Select role..."
                                size="small"
                                style={{ minWidth: 180 }}
                                showSearch
                                optionFilterProp="label"
                                options={catalogRoles.map((r) => ({
                                  value: r.nativeId,
                                  label: r.name,
                                  adminTier: r.adminTier,
                                }))}
                                onChange={(val) => {
                                  const role = catalogRoles.find((r) => r.nativeId === val);
                                  updateActionParams({
                                    roleName: role?.name ?? val,
                                    roleTemplateId: val,
                                  });
                                }}
                                optionRender={(opt) => {
                                  const data = opt as {
                                    label: React.ReactNode;
                                    adminTier?: string;
                                  };
                                  return (
                                    <Space>
                                      <span>{data.label}</span>
                                      {data.adminTier && (
                                        <Tag
                                          color={tierColor(data.adminTier)}
                                          style={{ fontSize: 10 }}
                                        >
                                          {data.adminTier}
                                        </Tag>
                                      )}
                                    </Space>
                                  );
                                }}
                                notFoundContent={catalogRoles.length === 0 ? 'Run discovery' : null}
                              />
                            )}
                          </Space>
                        </Col>
                        <Col flex="24px">
                          <Button
                            type="text"
                            danger
                            size="small"
                            aria-label="Remove action"
                            icon={<DeleteOutlined />}
                            onClick={() =>
                              setEditingBundle({
                                ...editingBundle,
                                actions: editingBundle.actions.filter((a) => a.id !== action.id),
                              })
                            }
                          />
                        </Col>
                      </Row>
                    );
                  })}
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'assign_group',
                          label: 'Assign Security Group',
                          onClick: () =>
                            setEditingBundle({
                              ...editingBundle,
                              actions: [
                                ...editingBundle.actions,
                                {
                                  id: `a-${crypto.randomUUID().slice(0, 8)}`,
                                  type: 'assign_group',
                                  target: 'entra-id',
                                  params: {},
                                },
                              ],
                            }),
                        },
                        {
                          key: 'assign_license',
                          label: 'Assign License',
                          onClick: () =>
                            setEditingBundle({
                              ...editingBundle,
                              actions: [
                                ...editingBundle.actions,
                                {
                                  id: `a-${crypto.randomUUID().slice(0, 8)}`,
                                  type: 'assign_license',
                                  target: 'entra-id',
                                  params: {},
                                },
                              ],
                            }),
                        },
                        {
                          key: 'assign_role',
                          label: 'Assign Directory Role',
                          onClick: () =>
                            setEditingBundle({
                              ...editingBundle,
                              actions: [
                                ...editingBundle.actions,
                                {
                                  id: `a-${crypto.randomUUID().slice(0, 8)}`,
                                  type: 'assign_role',
                                  target: 'entra-id',
                                  params: {},
                                },
                              ],
                            }),
                        },
                      ],
                    }}
                  >
                    <Button type="dashed" size="small" icon={<PlusOutlined />} block>
                      Add Action
                    </Button>
                  </Dropdown>
                </Space>
              </Collapse.Panel>
            </Collapse>
          </Form>
        )}
      </Modal>
    </Space>
  );
};
