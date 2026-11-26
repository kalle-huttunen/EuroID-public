/**
 * ImpactSummaryTab — Summary tab content for ImpactAnalysisModal.
 * Shows analysis text, dry-run info, and installed connector health.
 */
import React from 'react';
import { Alert, Space, Typography, Skeleton, List, Tag } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { IRiskSummary } from '../../../interfaces/impact-analysis.interface';
import type { IConnectorHealthStatus } from '../../../interfaces/reconciliation.interface';
import { relativeTime } from '../../../utils/date-helpers';

const { Text } = Typography;

export interface ImpactSummaryTabProps {
    hasRunOnce: boolean;
    summary: IRiskSummary;
    dryRunMode: boolean;
    healthLoading: boolean;
    connectorHealth: IConnectorHealthStatus[];
}

export const ImpactSummaryTab: React.FC<ImpactSummaryTabProps> = ({
    hasRunOnce, summary, dryRunMode, healthLoading, connectorHealth,
}) => (
    <div style={{ padding: '8px 0' }}>
        {hasRunOnce ? (
            <>
                <Text type="secondary">
                    Total users analyzed: {summary.totalUsers}. Creates: {summary.creates}
                    , Updates: {summary.updates}, Deletes: {summary.deletes}
                    {summary.noChange != null ? `, No change: ${summary.noChange}` : ''}
                    {summary.warnings != null ? `, Warnings: ${summary.warnings}` : ''}.
                </Text>
                {dryRunMode && (
                    <Alert message="Dry run mode is on — no changes have been applied." type="info" showIcon style={{ marginTop: 16 }} />
                )}
            </>
        ) : (
            <Text type="secondary">Run the impact analysis to see a summary of planned changes.</Text>
        )}
        <div style={{ marginTop: 20 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>Installed connectors</Text>
            {healthLoading ? (
                <Skeleton active paragraph={{ rows: 2 }} />
            ) : connectorHealth.length === 0 ? (
                <Text type="secondary">No connectors on the board, or health not available.</Text>
            ) : (
                <List
                    size="small"
                    dataSource={connectorHealth}
                    renderItem={(c) => {
                        const statusConfig =
                            c.status === 'healthy'
                                ? { color: 'success', icon: <CheckCircleOutlined /> }
                                : c.status === 'degraded'
                                  ? { color: 'warning', icon: <WarningOutlined /> }
                                  : c.status === 'down'
                                    ? { color: 'error', icon: <CloseCircleOutlined /> }
                                    : { color: 'default', icon: <QuestionCircleOutlined /> };
                        return (
                            <List.Item>
                                <Space>
                                    {statusConfig.icon}
                                    <Text>{c.connectorName}</Text>
                                    <Tag color={statusConfig.color}>{c.status}</Tag>
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                        Last checked: {c.lastChecked ? relativeTime(c.lastChecked) : 'Never'}
                                    </Text>
                                </Space>
                            </List.Item>
                        );
                    }}
                />
            )}
        </div>
    </div>
);
