/**
 * PolicyPreview - Impact Analysis for a Policy
 * 
 * Shows how many users will be affected by a policy before activation.
 * Now consumes real simulation results from POST /api/v1/policy/simulate
 * instead of evaluating locally against mock data.
 */

import React from 'react';
import { Card, Space, Tag, Typography, Statistic, Row, Col, Table, Alert, Spin, Badge, Progress, Divider, Button, theme } from 'antd';
import {
    UserOutlined,
    ApartmentOutlined,
    SafetyCertificateOutlined,
    CloudOutlined,
    ThunderboltOutlined,
    WarningOutlined,
    TeamOutlined,
    ArrowLeftOutlined,
    CheckCircleOutlined,
    CrownOutlined,
} from '@ant-design/icons';
import { Policy, ActionTarget } from './types';
import type { SimulationResult } from './PolicyEngineStudio';
import { PolicyDisplay } from './PolicyDisplay';

const { Text, Title } = Typography;

interface Props {
    policy: Partial<Policy>;
    simulationResult: SimulationResult | null;
    simulationLoading: boolean;
    /** When provided, shows "Back to Editor" button. Omit for standalone simulation view. */
    onBack?: () => void;
    /** When provided, shows a "Confirm and Save" button — indicates this preview came from Save */
    onConfirmSave?: () => void;
}

export const PolicyPreview: React.FC<Props> = ({ policy, simulationResult, simulationLoading, onBack, onConfirmSave }) => {
    const { token } = theme.useToken();
    const [saving, setSaving] = React.useState(false);
    const getTargetIcon = (target: string) => {
        const map: Record<string, React.ReactNode> = {
            'active-directory': <ApartmentOutlined style={{ color: token.colorPrimary }} />,
            'entra-id': <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />,
            'salesforce': <CloudOutlined style={{ color: token.colorInfo }} />,
            'all': <ThunderboltOutlined />,
        };
        return map[target] || null;
    };

    const getActionIcon = (actionType: string) => {
        if (actionType === 'assign_role') return <CrownOutlined style={{ color: token.colorWarning }} />;
        return null;
    };

    if (simulationLoading) {
        return (
            <div style={{ textAlign: 'center', padding: 60 }}>
                <Spin size="large" tip="Running simulation against Identity Hub users..."><div style={{ minHeight: 120 }} /></Spin>
            </div>
        );
    }

    // Use simulation results from backend, fall back to zeros
    const totalUsers = simulationResult?.totalUsers ?? 0;
    const matchedCount = simulationResult?.matchedCount ?? 0;
    const matchPercentage = simulationResult?.matchPercentage ?? 0;
    const matchedUsers = simulationResult?.matchedUsers ?? [];
    const actionsByTarget = simulationResult?.actionsBySystem ?? {};
    const totalOperations = simulationResult?.totalOperations ?? 0;

    return (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {/* Navigation */}
            <Space>
                {onBack && (
                    <Button type="link" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ padding: 0 }}>
                        Back to Editor
                    </Button>
                )}
                {onConfirmSave && (
                    <Button
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        loading={saving}
                        onClick={async () => {
                            setSaving(true);
                            try { await onConfirmSave(); } finally { setSaving(false); }
                        }}
                    >
                        Confirm and Save
                    </Button>
                )}
            </Space>

            {/* Policy Name + Progressive Disclosure */}
            <Card size="small" style={{ background: token.colorPrimaryBg, borderColor: token.colorPrimaryBorder }}>
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <Space>
                        <ThunderboltOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
                        <div>
                            <Title level={5} style={{ margin: 0 }}>{policy.name || 'Untitled Policy'}</Title>
                            <Text type="secondary" style={{ fontSize: 12 }}>{policy.description}</Text>
                        </div>
                    </Space>
                    <PolicyDisplay
                        policy={{
                            ...policy,
                            conditionGroups: policy.conditionGroups ?? [],
                            actions: policy.actions ?? [],
                            rawJson: policy as Record<string, unknown>,
                        }}
                    />
                </Space>
            </Card>

            {/* Impact Stats */}
            <Card size="small">
                <Row gutter={16} align="middle">
                    <Col span={6}>
                        <Statistic
                            title="Users Matched"
                            value={matchedCount}
                            suffix={`/ ${totalUsers}`}
                            prefix={<TeamOutlined />}
                            valueStyle={{ color: matchedCount > 0 ? token.colorPrimary : token.colorTextTertiary }}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="Coverage"
                            value={matchPercentage}
                            suffix="%"
                            valueStyle={{ color: matchPercentage > 50 ? token.colorWarning : token.colorSuccess }}
                        />
                        <Progress
                            percent={matchPercentage}
                            size="small"
                            strokeColor={matchPercentage > 50 ? token.colorWarning : token.colorSuccess}
                            showInfo={false}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="Actions per User"
                            value={policy.actions?.length || 0}
                            prefix={<ThunderboltOutlined />}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic
                            title="Total Operations"
                            value={totalOperations}
                            valueStyle={{ color: totalOperations > 20 ? token.colorWarning : token.colorSuccess }}
                        />
                    </Col>
                </Row>
            </Card>

            {/* Warnings */}
            {matchPercentage > 50 && (
                <Alert
                    message="Wide Impact Policy"
                    description={`This policy affects ${matchPercentage}% of your organization (${matchedCount} users). Consider using the "testing" status first.`}
                    type="warning"
                    showIcon
                    icon={<WarningOutlined />}
                />
            )}

            {matchedCount === 0 && totalUsers > 0 && (
                <Alert
                    message="No Users Match"
                    description="No users in the Identity Hub match these conditions. Check your condition values and operators."
                    type="info"
                    showIcon
                />
            )}

            {totalUsers === 0 && (
                <Alert
                    message="No Users in Identity Hub"
                    description="Seed users via POST /api/v1/batch-provision/seed or import from your HR source to see simulation results."
                    type="info"
                    showIcon
                />
            )}

            {/* Actions Breakdown */}
            <Card size="small" title={<Space><ThunderboltOutlined /> Actions that will execute per matched user</Space>}>
                <Space direction="vertical" style={{ width: '100%' }} size={4}>
                    {policy.actions?.map((action, idx) => {
                        const targetColor = action.target === 'active-directory' ? 'blue' : action.target === 'entra-id' ? 'purple' : action.target === 'salesforce' ? 'cyan' : 'default';
                        return (
                            <Row key={action.id} gutter={8} align="middle" style={{ padding: '6px 8px', background: token.colorFillQuaternary, borderRadius: 4 }}>
                                <Col flex="28px">
                                    <Badge count={idx + 1} style={{ backgroundColor: token.colorPrimary }} />
                                </Col>
                                <Col flex="auto">
                                    <Space>
                                        {getActionIcon(action.type) ?? getTargetIcon(action.target)}
                                        <Tag color={targetColor}>{action.target}</Tag>
                                        <Text style={{ fontSize: 12 }}>
                                            {action.type === 'assign_role' ? 'Assign Role' : action.label || action.type}
                                            {action.params.groupName && `: ${action.params.groupName}`}
                                            {action.params.roleName && `: ${action.params.roleName}`}
                                            {action.params.licenseSku && `: ${action.params.licenseSku}`}
                                            {action.params.mfaMethod && `: ${action.params.mfaMethod}`}
                                        </Text>
                                    </Space>
                                </Col>
                                <Col>
                                    <Text type="secondary" style={{ fontSize: 11 }}>
                                        x {matchedCount} users
                                    </Text>
                                </Col>
                            </Row>
                        );
                    })}
                </Space>

                {/* Per-system summary */}
                <Divider style={{ margin: '12px 0' }} />
                <Row gutter={16}>
                    {Object.entries(actionsByTarget).map(([target, count]) => (
                        <Col key={target}>
                            <Space>
                                {getTargetIcon(target)}
                                <Text style={{ fontSize: 12 }}>
                                    {target}: <Text strong>{count} action{count !== 1 ? 's' : ''}</Text> x {matchedCount} users = <Text strong style={{ color: token.colorPrimary }}>{count * matchedCount} operations</Text>
                                </Text>
                            </Space>
                        </Col>
                    ))}
                </Row>
            </Card>

            {/* Matched Users */}
            <Card
                size="small"
                title={
                    <Space>
                        <TeamOutlined />
                        <Text strong>Matched Users</Text>
                        <Badge count={matchedCount} style={{ backgroundColor: token.colorInfo }} />
                    </Space>
                }
            >
                <Table
                    dataSource={matchedUsers}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 5 }}
                    columns={[
                        {
                            title: 'Name',
                            key: 'name',
                            render: (_, record) => (
                                <Space direction="vertical" size={0}>
                                    <Text strong style={{ fontSize: 12 }}>{record.firstName} {record.lastName}</Text>
                                    <Text type="secondary" style={{ fontSize: 10 }}>{record.email}</Text>
                                </Space>
                            ),
                        },
                        {
                            title: 'Department',
                            dataIndex: 'department',
                            key: 'department',
                            render: (text: string) => <Tag>{text || '-'}</Tag>,
                        },
                        {
                            title: 'Job Title',
                            dataIndex: 'jobTitle',
                            key: 'jobTitle',
                            render: (text: string) => <Text style={{ fontSize: 11 }}>{text || '-'}</Text>,
                        },
                        {
                            title: 'Type',
                            dataIndex: 'employmentType',
                            key: 'employmentType',
                            render: (text: string) => {
                                const color = text === 'FULL_TIME' ? 'green' : text === 'CONTRACTOR' ? 'orange' : 'blue';
                                return <Tag color={color} style={{ fontSize: 10 }}>{text || '-'}</Tag>;
                            },
                        },
                        {
                            title: 'Location',
                            dataIndex: 'location',
                            key: 'location',
                            render: (text: string) => <Text type="secondary" style={{ fontSize: 11 }}>{text || '-'}</Text>,
                        },
                        {
                            title: 'Actions',
                            key: 'willReceive',
                            render: () => (
                                <Space size={2}>
                                    {policy.actions?.slice(0, 3).map(a => (
                                        <Tag key={a.id} color={a.target === 'active-directory' ? 'blue' : a.target === 'entra-id' ? 'purple' : 'cyan'} style={{ fontSize: 9 }}>
                                            {a.params.groupName || a.params.roleName || a.params.licenseSku || a.type}
                                        </Tag>
                                    ))}
                                    {(policy.actions?.length || 0) > 3 && <Text type="secondary" style={{ fontSize: 9 }}>+{(policy.actions?.length || 0) - 3}</Text>}
                                </Space>
                            ),
                        },
                    ]}
                />
            </Card>

            {/* Conditions Summary */}
            <Card size="small" title="Conditions Applied">
                <Space direction="vertical" size={4}>
                    {policy.conditionGroups?.map(group => (
                        <div key={group.id}>
                            {group.conditions.length > 1 && (
                                <Tag color="purple" style={{ marginBottom: 4, fontSize: 10 }}>{group.join} group</Tag>
                            )}
                            {group.conditions.map((c, idx) => (
                                <div key={c.id} style={{ marginLeft: 8, padding: '2px 0' }}>
                                    {idx > 0 && <Tag color={group.join === 'AND' ? 'blue' : 'orange'} style={{ fontSize: 9, marginRight: 4 }}>{group.join}</Tag>}
                                    <Text code style={{ fontSize: 11 }}>
                                        {c.field} {c.operator.replace('_', ' ')} "{Array.isArray(c.value) ? c.value.join(', ') : c.value}"
                                    </Text>
                                </div>
                            ))}
                        </div>
                    ))}
                </Space>
            </Card>
        </Space>
    );
};
