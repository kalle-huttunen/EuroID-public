/**
 * RiskReportTab - Risk distribution, high-risk operations, VIP affected, deletes section
 */

import React from 'react';
import { Card, List, Tag, Typography, Space, Alert, Skeleton, theme } from 'antd';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { WarningOutlined, CrownOutlined, UserDeleteOutlined } from '@ant-design/icons';
import type { IUserDelta, IRiskSummary } from '../../interfaces/impact-analysis.interface';
import type { IStandardUser } from '../../interfaces';
import { BRAND } from '../../theme';

const { Text, Title } = Typography;

const RISK_COLORS: Record<string, string> = {
    Low: BRAND.success,
    Medium: BRAND.warning,
    High: BRAND.warning,
    Critical: BRAND.error,
};

interface RiskReportTabProps {
    deltas: IUserDelta[];
    summary: IRiskSummary;
    testUsers: IStandardUser[];
    loading?: boolean;
}

export const RiskReportTab: React.FC<RiskReportTabProps> = ({
    deltas,
    summary: _summary,
    testUsers,
    loading = false,
}) => {
    const { token } = theme.useToken();
    const vipIds = new Set(
        testUsers.filter(u => u.priority === 'VIP').map(u => u._id ?? u.sourceUserId)
    );
    const riskCounts = React.useMemo(() => {
        const m: Record<string, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 };
        deltas.forEach(d => {
            m[d.risk] = (m[d.risk] ?? 0) + 1;
        });
        return [
            { name: 'Low', value: m.Low, color: RISK_COLORS.Low },
            { name: 'Medium', value: m.Medium, color: RISK_COLORS.Medium },
            { name: 'High', value: m.High, color: RISK_COLORS.High },
            { name: 'Critical', value: m.Critical, color: RISK_COLORS.Critical },
        ].filter(x => x.value > 0);
    }, [deltas]);

    const highRiskDeltas = deltas.filter(d => d.risk === 'High' || d.risk === 'Critical');
    const vipAffected = deltas.filter(d => vipIds.has(d.userId));
    const deleteDeltas = deltas.filter(d => d.action === 'DELETE');

    if (loading) {
        return <Skeleton active paragraph={{ rows: 8 }} />;
    }

    if (deltas.length === 0) {
        return (
            <Alert
                message="No risk data"
                description="Run the impact analysis to see risk distribution and high-risk operations."
                type="info"
                showIcon
            />
        );
    }

    return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Pie chart */}
            {riskCounts.length > 0 && (
                <Card size="small" title="Risk distribution">
                    <div style={{ width: '100%', height: 260 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={riskCounts}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={90}
                                    paddingAngle={2}
                                    dataKey="value"
                                    nameKey="name"
                                    label={({ name, value }) => `${name}: ${value}`}
                                >
                                    {riskCounts.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip formatter={(value: unknown) => (typeof value === 'number' ? `${value} users` : '—')} />
                                <Legend />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
            )}

            {/* High-risk operations */}
            {highRiskDeltas.length > 0 && (
                <Card
                    size="small"
                    title={
                        <Space>
                            <WarningOutlined style={{ color: token.colorError }} />
                            High-risk operations
                        </Space>
                    }
                >
                    <List
                        size="small"
                        dataSource={highRiskDeltas}
                        renderItem={d => (
                            <List.Item>
                                <Space>
                                    <Tag color={d.risk === 'Critical' ? 'red' : 'orange'}>
                                        {d.risk}
                                    </Tag>
                                    <Text strong>{d.displayName}</Text>
                                    <Tag>{d.action}</Tag>
                                    <Text type="secondary">{d.targetSystem}</Text>
                                    {d.warnings?.map((w, i) => (
                                        <Text key={i} type="danger" style={{ fontSize: 12 }}>
                                            {w}
                                        </Text>
                                    ))}
                                </Space>
                            </List.Item>
                        )}
                    />
                </Card>
            )}

            {/* VIP users affected */}
            {vipAffected.length > 0 && (
                <Card
                    size="small"
                    title={
                        <Space>
                            <CrownOutlined style={{ color: token.colorWarning }} />
                            VIP users affected
                        </Space>
                    }
                >
                    <List
                        size="small"
                        dataSource={vipAffected}
                        renderItem={d => (
                            <List.Item>
                                <Space>
                                    <CrownOutlined />
                                    <Text strong>{d.displayName}</Text>
                                    <Tag>{d.action}</Tag>
                                    <Tag color={d.risk === 'Critical' ? 'red' : 'orange'}>
                                        {d.risk}
                                    </Tag>
                                </Space>
                            </List.Item>
                        )}
                    />
                </Card>
            )}

            {/* Delete operations (requires approval) */}
            {deleteDeltas.length > 0 && (
                <Card
                    size="small"
                    title={
                        <Space>
                            <UserDeleteOutlined style={{ color: token.colorError }} />
                            Delete operations (require approval)
                        </Space>
                    }
                >
                    <Alert
                        message={`${deleteDeltas.length} user(s) will be deleted. Review before proceeding.`}
                        type="warning"
                        showIcon
                        style={{ marginBottom: 12 }}
                    />
                    <List
                        size="small"
                        dataSource={deleteDeltas}
                        renderItem={d => (
                            <List.Item>
                                <Space>
                                    <Text strong>{d.displayName}</Text>
                                    <Text type="secondary">{d.upn}</Text>
                                    {d.warnings?.map((w, i) => (
                                        <Tag key={i} color="orange">
                                            {w}
                                        </Tag>
                                    ))}
                                </Space>
                            </List.Item>
                        )}
                    />
                </Card>
            )}

            {highRiskDeltas.length === 0 && vipAffected.length === 0 && deleteDeltas.length === 0 && (
                <Alert
                    message="No high-risk or delete operations"
                    description="All planned changes are low or medium risk."
                    type="success"
                    showIcon
                />
            )}
        </Space>
    );
};
