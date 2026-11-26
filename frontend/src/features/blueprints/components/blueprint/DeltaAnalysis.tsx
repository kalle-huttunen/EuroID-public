/**
 * DeltaAnalysis - Impact Map for Mass Operations
 * 
 * This component categorizes users into three buckets to prevent "Admin Regret"
 * when syncing large batches of users to systems like Entra ID:
 * 
 * 1. DESTRUCTIVE: Users flagged for deletion or disabling (HIGH VISIBILITY)
 * 2. EDIT: Users being modified with precise attribute diffs
 * 3. CREATE: New users that don't exist in the target system yet
 * 
 * The "Dirty Diff" feature shows exactly what's changing (e.g., JobTitle: "Sales Lead" → "Regional VP")
 */

import React, { useState } from 'react';
import { Card, Collapse, Badge, Space, Table, Tag, Typography, Alert, Divider, Statistic, Row, Col, Select, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { 
    DeleteOutlined, 
    EditOutlined, 
    PlusCircleOutlined, 
    WarningOutlined,
    UserDeleteOutlined,
    StopOutlined,
    CrownOutlined,
    CheckCircleOutlined
} from '@ant-design/icons';

const { Panel } = Collapse;
const { Text, Title } = Typography;

export interface UserDelta {
    userId: string;
    displayName: string;
    upn?: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE' | 'NO_CHANGE';
    risk: 'Low' | 'Medium' | 'High' | 'Critical';
    changes?: {
        field: string;
        oldValue: string | null;
        newValue: string | null;
        impact: 'Low' | 'Medium' | 'High';
    }[];
    warnings?: string[];
    targetSystem: string;
}

interface Props {
    deltas: UserDelta[];
    loading?: boolean;
    /** Unified table view (single table with expandable rows, risk, VIP crown, sortable, filterable) */
    variant?: 'grouped' | 'unified';
    /** User IDs to show VIP crown (e.g. priority === 'VIP') */
    vipUserIds?: Set<string>;
}

export const DeltaAnalysis: React.FC<Props> = ({ deltas, loading = false, variant = 'grouped', vipUserIds }) => {
    const { token } = theme.useToken();
    const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);

    // Categorize deltas
    const destructiveActions = deltas.filter(d => d.action === 'DELETE' || d.action === 'DISABLE');
    const editActions = deltas.filter(d => d.action === 'UPDATE');
    const createActions = deltas.filter(d => d.action === 'CREATE');

    // Critical stats
    const highRiskCount = deltas.filter(d => d.risk === 'High' || d.risk === 'Critical').length;
    const totalChanges = deltas.reduce((sum, d) => sum + (d.changes?.length || 0), 0);

    const getActionIcon = (action: string) => {
        const iconMap = {
            DELETE: <DeleteOutlined style={{ color: token.colorError }} />,
            DISABLE: <StopOutlined style={{ color: token.colorWarning }} />,
            UPDATE: <EditOutlined style={{ color: token.colorPrimary }} />,
            CREATE: <PlusCircleOutlined style={{ color: token.colorSuccess }} />,
            NO_CHANGE: <CheckCircleOutlined style={{ color: token.colorTextTertiary }} />,
        };
        return iconMap[action as keyof typeof iconMap] || null;
    };

    const getRiskTag = (risk: string, boldCritical = false) => {
        const colorMap = {
            Low: 'green',
            Medium: 'orange',
            High: 'red',
            Critical: 'red',
        };
        const color = colorMap[risk as keyof typeof colorMap];
        return (
            <Tag color={color} style={boldCritical && risk === 'Critical' ? { fontWeight: 700 } : undefined}>
                {risk}
            </Tag>
        );
    };

    // ── Unified table (single table, expandable rows, VIP, sortable, filterable) ──
    if (variant === 'unified') {
        const filteredDeltas = actionFilter
            ? deltas.filter(d => d.action === actionFilter)
            : deltas;

        const unifiedColumns: ColumnsType<UserDelta> = [
            {
                title: 'User Name',
                dataIndex: 'displayName',
                key: 'displayName',
                width: 200,
                sorter: (a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''),
                render: (text: string, record: UserDelta) => (
                    <Space>
                        {vipUserIds?.has(record.userId) && (
                            <CrownOutlined style={{ color: token.colorWarning }} title="VIP user" />
                        )}
                        <Space direction="vertical" size={0}>
                            <Text strong>{text}</Text>
                            {record.upn && (
                                <Text type="secondary" style={{ fontSize: 11 }}>{record.upn}</Text>
                            )}
                        </Space>
                    </Space>
                ),
            },
            {
                title: 'Action',
                dataIndex: 'action',
                key: 'action',
                width: 110,
                sorter: (a, b) => String(a.action).localeCompare(String(b.action)),
                render: (action: string) => (
                    <Space>
                        {getActionIcon(action)}
                        <Text>{action}</Text>
                    </Space>
                ),
            },
            {
                title: 'Risk',
                dataIndex: 'risk',
                key: 'risk',
                width: 100,
                sorter: (a, b) => {
                    const order = { Low: 0, Medium: 1, High: 2, Critical: 3 };
                    return (order[a.risk] ?? 0) - (order[b.risk] ?? 0);
                },
                render: (risk: string) => getRiskTag(risk, true),
            },
            {
                title: 'Changes',
                dataIndex: 'changes',
                key: 'changes',
                ellipsis: true,
                render: (changes: UserDelta['changes']) => (
                    <Space direction="vertical" size={0}>
                        {changes?.length ? (
                            changes.slice(0, 2).map((c, i) => (
                                <span key={i} style={{ fontSize: 12 }}>
                                    <Text code style={{ fontSize: 11 }}>{c.field}</Text>{' '}
                                    <Text delete type="secondary">{c.oldValue ?? '—'}</Text>
                                    {' → '}
                                    <Text strong style={{ color: token.colorSuccess }}>{c.newValue ?? '—'}</Text>
                                </span>
                            ))
                        ) : (
                            <Text type="secondary">—</Text>
                        )}
                        {changes && changes.length > 2 && (
                            <Text type="secondary" style={{ fontSize: 11 }}>
                                +{changes.length - 2} more (expand row)
                            </Text>
                        )}
                    </Space>
                ),
            },
            {
                title: 'Warnings',
                dataIndex: 'warnings',
                key: 'warnings',
                width: 180,
                render: (warnings: string[] | undefined) => (
                    <Space direction="vertical" size={0}>
                        {warnings?.length
                            ? warnings.map((w, i) => (
                                  <Text key={i} type="danger" style={{ fontSize: 11 }}>
                                      <WarningOutlined /> {w}
                                  </Text>
                              ))
                            : <Text type="secondary">—</Text>}
                    </Space>
                ),
            },
        ];

        return (
            <div>
                {deltas.length > 0 && (
                    <Space style={{ marginBottom: 12 }}>
                        <Text type="secondary">Filter by action:</Text>
                        <Select
                            placeholder="All actions"
                            allowClear
                            style={{ width: 140 }}
                            value={actionFilter || undefined}
                            onChange={v => setActionFilter(v ?? undefined)}
                            options={[
                                { value: 'CREATE', label: 'Creates' },
                                { value: 'UPDATE', label: 'Updates' },
                                { value: 'DELETE', label: 'Deletes' },
                                { value: 'DISABLE', label: 'Disable' },
                                { value: 'NO_CHANGE', label: 'No change' },
                            ]}
                        />
                    </Space>
                )}
                <Table<UserDelta>
                    dataSource={filteredDeltas}
                    columns={unifiedColumns}
                    rowKey="userId"
                    loading={loading}
                    size="small"
                    pagination={{ pageSize: 10, showSizeChanger: true }}
                    expandable={{
                        expandedRowRender: (record) => (
                            <div style={{ padding: '8px 24px', background: token.colorFillQuaternary }}>
                                <Text strong style={{ marginBottom: 8, display: 'block' }}>
                                    Before / After
                                </Text>
                                {record.changes?.length ? (
                                    <Space direction="vertical" size={4}>
                                        {record.changes.map((c, i) => (
                                            <div key={i}>
                                                <Text code>{c.field}</Text>
                                                <br />
                                                <Text delete type="secondary">
                                                    {c.oldValue ?? '(empty)'}
                                                </Text>
                                                {' → '}
                                                <Text strong style={{ color: token.colorSuccess }}>
                                                    {c.newValue ?? '(empty)'}
                                                </Text>
                                                {c.impact !== 'Low' && (
                                                    <Tag
                                                        color={c.impact === 'High' ? 'red' : 'orange'}
                                                        style={{ marginLeft: 8, fontSize: 10 }}
                                                    >
                                                        {c.impact}
                                                    </Tag>
                                                )}
                                            </div>
                                        ))}
                                    </Space>
                                ) : (
                                    <Text type="secondary">No field changes</Text>
                                )}
                            </div>
                        ),
                        rowExpandable: (record) => (record.changes?.length ?? 0) > 0,
                    }}
                />
                {deltas.length === 0 && !loading && (
                    <Alert
                        message="No Changes Detected"
                        description="Run impact analysis to see user deltas."
                        type="info"
                        showIcon
                    />
                )}
            </div>
        );
    }

    // Table columns for destructive actions
    const destructiveColumns = [
        {
            title: 'User',
            dataIndex: 'displayName',
            key: 'displayName',
            render: (text: string, record: UserDelta) => (
                <Space direction="vertical" size={0}>
                    <Text strong>{text}</Text>
                    {record.upn && <Text type="secondary" style={{ fontSize: 11 }}>{record.upn}</Text>}
                </Space>
            ),
        },
        {
            title: 'Action',
            dataIndex: 'action',
            key: 'action',
            render: (action: string) => (
                <Space>
                    {getActionIcon(action)}
                    <Text>{action}</Text>
                </Space>
            ),
        },
        {
            title: 'System',
            dataIndex: 'targetSystem',
            key: 'targetSystem',
            render: (system: string) => <Tag>{system}</Tag>,
        },
        {
            title: 'Risk',
            dataIndex: 'risk',
            key: 'risk',
            render: (risk: string) => getRiskTag(risk),
        },
        {
            title: 'Warnings',
            dataIndex: 'warnings',
            key: 'warnings',
            render: (warnings: string[]) => (
                <Space direction="vertical" size={0}>
                    {warnings?.map((w, i) => (
                        <Text key={i} type="danger" style={{ fontSize: 11 }}>
                            <WarningOutlined /> {w}
                        </Text>
                    ))}
                </Space>
            ),
        },
    ];

    // Table columns for edits (with diff)
    const editColumns = [
        {
            title: 'User',
            dataIndex: 'displayName',
            key: 'displayName',
            render: (text: string, record: UserDelta) => (
                <Space direction="vertical" size={0}>
                    <Text strong>{text}</Text>
                    {record.upn && <Text type="secondary" style={{ fontSize: 11 }}>{record.upn}</Text>}
                </Space>
            ),
        },
        {
            title: 'Changes',
            dataIndex: 'changes',
            key: 'changes',
            render: (changes: UserDelta['changes']) => (
                <Space direction="vertical" size={2}>
                    {changes?.map((change, i) => (
                        <div key={i} style={{ fontSize: 12 }}>
                            <Text code style={{ fontSize: 11 }}>{change.field}</Text>
                            <br />
                            <Space size={4}>
                                <Text delete type="secondary">{change.oldValue || '(empty)'}</Text>
                                <Text>→</Text>
                                <Text strong style={{ color: token.colorSuccess }}>{change.newValue || '(empty)'}</Text>
                                {change.impact !== 'Low' && (
                                    <Tag color={change.impact === 'High' ? 'red' : 'orange'} style={{ fontSize: 10 }}>
                                        {change.impact}
                                    </Tag>
                                )}
                            </Space>
                        </div>
                    ))}
                </Space>
            ),
        },
        {
            title: 'System',
            dataIndex: 'targetSystem',
            key: 'targetSystem',
            render: (system: string) => <Tag>{system}</Tag>,
        },
        {
            title: 'Risk',
            dataIndex: 'risk',
            key: 'risk',
            render: (risk: string) => getRiskTag(risk),
        },
    ];

    // Table columns for creates
    const createColumns = [
        {
            title: 'User',
            dataIndex: 'displayName',
            key: 'displayName',
            render: (text: string, record: UserDelta) => (
                <Space direction="vertical" size={0}>
                    <Text strong>{text}</Text>
                    {record.upn && <Text type="secondary" style={{ fontSize: 11 }}>{record.upn}</Text>}
                </Space>
            ),
        },
        {
            title: 'System',
            dataIndex: 'targetSystem',
            key: 'targetSystem',
            render: (system: string) => <Tag>{system}</Tag>,
        },
        {
            title: 'Risk',
            dataIndex: 'risk',
            key: 'risk',
            render: (risk: string) => getRiskTag(risk),
        },
    ];

    return (
        <div>
            {/* Summary Statistics */}
            <Card size="small" style={{ marginBottom: 16, background: token.colorFillQuaternary }}>
                <Row gutter={16}>
                    <Col span={6}>
                        <Statistic 
                            title="Total Impact" 
                            value={deltas.length}
                            suffix="users"
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic 
                            title="Destructive Actions" 
                            value={destructiveActions.length}
                            valueStyle={{ color: destructiveActions.length > 0 ? token.colorErrorActive : token.colorTextTertiary }}
                            prefix={<UserDeleteOutlined />}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic 
                            title="High Risk Items" 
                            value={highRiskCount}
                            valueStyle={{ color: highRiskCount > 0 ? token.colorErrorActive : token.colorTextTertiary }}
                            prefix={<WarningOutlined />}
                        />
                    </Col>
                    <Col span={6}>
                        <Statistic 
                            title="Total Changes" 
                            value={totalChanges}
                            suffix="fields"
                        />
                    </Col>
                </Row>
            </Card>

            {/* Critical Warning for Destructive Actions */}
            {destructiveActions.length > 0 && (
                <Alert
                    message="⚠️ DESTRUCTIVE ACTIONS DETECTED"
                    description={`${destructiveActions.length} user(s) will be deleted or disabled. Review carefully to avoid removing service accounts or VIPs.`}
                    type="error"
                    showIcon
                    icon={<WarningOutlined />}
                    style={{ marginBottom: 16 }}
                />
            )}

            {/* Collapsible Sections */}
            <Collapse 
                defaultActiveKey={destructiveActions.length > 0 ? ['destructive'] : ['create']}
                style={{ marginBottom: 16 }}
            >
                {/* DESTRUCTIVE ACTIONS */}
                {destructiveActions.length > 0 && (
                    <Panel
                        header={
                            <Space>
                                <Badge count={destructiveActions.length} style={{ backgroundColor: token.colorError }} />
                                <UserDeleteOutlined style={{ color: token.colorError }} />
                                <Text strong>Destructive Actions (DELETE / DISABLE)</Text>
                            </Space>
                        }
                        key="destructive"
                        style={{ borderLeft: `4px solid ${token.colorError}` }}
                    >
                        <Table
                            dataSource={destructiveActions}
                            columns={destructiveColumns}
                            pagination={false}
                            size="small"
                            rowKey="userId"
                            loading={loading}
                        />
                    </Panel>
                )}

                {/* EDIT ACTIONS */}
                {editActions.length > 0 && (
                    <Panel
                        header={
                            <Space>
                                <Badge count={editActions.length} style={{ backgroundColor: token.colorPrimary }} />
                                <EditOutlined style={{ color: token.colorPrimary }} />
                                <Text strong>Updates (The "Dirty" Diff)</Text>
                            </Space>
                        }
                        key="edit"
                        style={{ borderLeft: `4px solid ${token.colorPrimary}` }}
                    >
                        <Table
                            dataSource={editActions}
                            columns={editColumns}
                            pagination={{ pageSize: 10 }}
                            size="small"
                            rowKey="userId"
                            loading={loading}
                        />
                    </Panel>
                )}

                {/* CREATE ACTIONS */}
                {createActions.length > 0 && (
                    <Panel
                        header={
                            <Space>
                                <Badge count={createActions.length} style={{ backgroundColor: token.colorSuccess }} />
                                <PlusCircleOutlined style={{ color: token.colorSuccess }} />
                                <Text strong>New Entities (Will be Created)</Text>
                            </Space>
                        }
                        key="create"
                        style={{ borderLeft: `4px solid ${token.colorSuccess}` }}
                    >
                        <Table
                            dataSource={createActions}
                            columns={createColumns}
                            pagination={{ pageSize: 10 }}
                            size="small"
                            rowKey="userId"
                            loading={loading}
                        />
                    </Panel>
                )}
            </Collapse>

            {/* Empty State */}
            {deltas.length === 0 && !loading && (
                <Alert
                    message="No Changes Detected"
                    description="The current user list matches the target system. No actions required."
                    type="info"
                    showIcon
                />
            )}
        </div>
    );
};
