/**
 * ConnectorManager - Connector Health, Selection & Lifecycle Management
 * 
 * This component provides a control center for managing all connectors before running
 * impact analysis or dry-run simulations. It prevents "Admin Regret" by ensuring only
 * healthy, properly configured connectors are used in production operations.
 * 
 * Features:
 * - Real-time health monitoring with credential validation
 * - Selective enable/disable of connectors for simulation runs
 * - Connector deletion (returns to canvas as "available to add")
 * - API rate limit tracking for systems like Microsoft Graph API
 * - Warning system for unhealthy connectors
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Space, Switch, Button, Badge, Tooltip, Alert, Statistic, Row, Col, Popconfirm, Tag, Typography, theme } from 'antd';

const { Text } = Typography;
import { 
    CheckCircleOutlined, 
    CloseCircleOutlined, 
    DeleteOutlined, 
    WarningOutlined,
    ApiOutlined,
    ThunderboltOutlined 
} from '@ant-design/icons';
import { API_BASE } from '@api/constants';
import { axiosInstance } from '@api/data';

export interface ConnectorStatus {
    id: string;
    name: string;
    type: string;
    health: 'online' | 'offline' | 'degraded' | 'checking';
    enabled: boolean;
    credentials: {
        valid: boolean;
        expiresIn?: string;
    };
    rateLimit?: {
        remaining: number;
        total: number;
        resetTime?: string;
    };
    lastChecked?: Date;
    errorMessage?: string;
}

interface Props {
    connectors: string[];
    onConnectorToggle: (connectorId: string, enabled: boolean) => void;
    onConnectorDelete: (connectorId: string) => void;
    onRefreshHealth: () => void;
}

export const ConnectorManager: React.FC<Props> = ({
    connectors,
    onConnectorToggle,
    onConnectorDelete,
    onRefreshHealth: _onRefreshHealth,
}) => {
    const { token } = theme.useToken();
    const [connectorStatuses, setConnectorStatuses] = useState<Record<string, ConnectorStatus>>({});
    const [loading, setLoading] = useState(false);

    const fetchAllHealth = useCallback(async () => {
        setLoading(true);
        const statusMap: Record<string, ConnectorStatus> = {};

        for (const connectorId of connectors) {
            try {
                const { data } = await axiosInstance.get(`${API_BASE}/blueprints/connector-status/${connectorId}`);
                statusMap[connectorId] = {
                    id: connectorId,
                    name: data.name || connectorId,
                    type: data.type || 'Unknown',
                    health: data.health || 'offline',
                    enabled: data.enabled !== false, // Default to enabled
                    credentials: data.credentials || { valid: false },
                    rateLimit: data.rateLimit,
                    lastChecked: new Date(),
                    errorMessage: data.errorMessage,
                };
            } catch {
                statusMap[connectorId] = {
                    id: connectorId,
                    name: connectorId,
                    type: 'Unknown',
                    health: 'offline',
                    enabled: false,
                    credentials: { valid: false },
                    lastChecked: new Date(),
                    errorMessage: 'Failed to fetch status',
                };
            }
        }

        setConnectorStatuses(statusMap);
        setLoading(false);
    }, [connectors]);

    useEffect(() => {
        queueMicrotask(() => fetchAllHealth());
    }, [fetchAllHealth]);

    const getHealthBadge = (health: string) => {
        const statusMap = {
            online: { status: 'success' as const, text: 'Online', icon: <CheckCircleOutlined /> },
            offline: { status: 'error' as const, text: 'Offline', icon: <CloseCircleOutlined /> },
            degraded: { status: 'warning' as const, text: 'Degraded', icon: <WarningOutlined /> },
            checking: { status: 'processing' as const, text: 'Checking...', icon: <ApiOutlined /> },
        };
        return statusMap[health as keyof typeof statusMap] || statusMap.offline;
    };

    const handleToggle = (connectorId: string, enabled: boolean) => {
        setConnectorStatuses(prev => ({
            ...prev,
            [connectorId]: { ...prev[connectorId], enabled }
        }));
        onConnectorToggle(connectorId, enabled);
    };

    const handleDelete = (connectorId: string) => {
        onConnectorDelete(connectorId);
    };

    const unhealthyCount = Object.values(connectorStatuses).filter(c => c.health !== 'online').length;
    const disabledCount = Object.values(connectorStatuses).filter(c => !c.enabled).length;

    return (
        <div style={{ marginBottom: 24 }}>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
                {/* Summary Header */}
                <Card size="small">
                    <Row gutter={16}>
                        <Col span={6}>
                            <Statistic 
                                title="Total Connectors" 
                                value={connectors.length} 
                                prefix={<ApiOutlined />}
                            />
                        </Col>
                        <Col span={6}>
                            <Statistic 
                                title="Healthy" 
                                value={connectors.length - unhealthyCount}
                                valueStyle={{ color: token.colorSuccess }}
                                prefix={<CheckCircleOutlined />}
                            />
                        </Col>
                        <Col span={6}>
                            <Statistic 
                                title="Issues" 
                                value={unhealthyCount}
                                valueStyle={{ color: unhealthyCount > 0 ? token.colorErrorActive : token.colorTextTertiary }}
                                prefix={<WarningOutlined />}
                            />
                        </Col>
                        <Col span={6}>
                            <Statistic 
                                title="Disabled" 
                                value={disabledCount}
                                valueStyle={{ color: token.colorTextTertiary }}
                            />
                        </Col>
                    </Row>
                    <Button 
                        type="link" 
                        icon={<ThunderboltOutlined />} 
                        onClick={fetchAllHealth}
                        loading={loading}
                        style={{ marginTop: 12 }}
                    >
                        Refresh All Health Checks
                    </Button>
                </Card>

                {/* Warning for unhealthy connectors */}
                {unhealthyCount > 0 && (
                    <Alert
                        message="Connector Health Issues Detected"
                        description={`${unhealthyCount} connector(s) are not healthy. Disable them or fix the configuration before running production syncs.`}
                        type="warning"
                        showIcon
                        icon={<WarningOutlined />}
                    />
                )}

                {/* Connector List */}
                {Object.values(connectorStatuses).map(connector => {
                    const healthBadge = getHealthBadge(connector.health);
                    
                    return (
                        <Card 
                            key={connector.id}
                            size="small"
                            style={{
                                borderLeft: connector.health === 'online'
                                    ? `4px solid ${token.colorSuccess}`
                                    : connector.enabled
                                        ? `4px solid ${token.colorError}`
                                        : `4px solid ${token.colorBorder}`
                            }}
                        >
                            <Space direction="vertical" style={{ width: '100%' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <Space>
                                        <Badge status={healthBadge.status} />
                                        <strong>{connector.name}</strong>
                                        <Tag>{connector.type}</Tag>
                                    </Space>
                                    <Space>
                                        <Tooltip title={connector.enabled ? "Disable for simulation" : "Enable for simulation"}>
                                            <Switch 
                                                checked={connector.enabled}
                                                onChange={(checked) => handleToggle(connector.id, checked)}
                                                checkedChildren="Enabled"
                                                unCheckedChildren="Disabled"
                                                aria-label={connector.enabled ? `Disable ${connector.name}` : `Enable ${connector.name}`}
                                            />
                                        </Tooltip>
                                        <Popconfirm
                                            title="Delete this connector?"
                                            description="It will be removed from the canvas and returned to the available connectors list."
                                            onConfirm={() => handleDelete(connector.id)}
                                            okText="Yes, Delete"
                                            cancelText="Cancel"
                                        >
                                            <Button 
                                                type="text" 
                                                danger 
                                                icon={<DeleteOutlined />}
                                                size="small"
                                                aria-label={`Remove ${connector.name} connector`}
                                            >
                                                Remove
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                </div>

                                {/* Health Details */}
                                <Row gutter={16}>
                                    <Col span={8}>
                                        <Text type="secondary" style={{ fontSize: 12 }}>Status</Text>
                                        <div>
                                            <Space>
                                                {healthBadge.icon}
                                                <span style={{ fontSize: 13 }}>{healthBadge.text}</span>
                                            </Space>
                                        </div>
                                    </Col>
                                    <Col span={8}>
                                        <Text type="secondary" style={{ fontSize: 12 }}>Credentials</Text>
                                        <div>
                                            {connector.credentials.valid ? (
                                                <Tag color="green">Valid</Tag>
                                            ) : (
                                                <Tag color="red">Invalid/Missing</Tag>
                                            )}
                                            {connector.credentials.expiresIn && (
                                                <Text type="secondary" style={{ fontSize: 11 }}>
                                                    Expires: {connector.credentials.expiresIn}
                                                </Text>
                                            )}
                                        </div>
                                    </Col>
                                    <Col span={8}>
                                        {connector.rateLimit && (
                                            <>
                                                <Text type="secondary" style={{ fontSize: 12 }}>API Rate Limit</Text>
                                                <div>
                                                    <Tag color={connector.rateLimit.remaining > 100 ? 'blue' : 'orange'}>
                                                        {connector.rateLimit.remaining} / {connector.rateLimit.total}
                                                    </Tag>
                                                </div>
                                            </>
                                        )}
                                    </Col>
                                </Row>

                                {/* Error Message */}
                                {connector.errorMessage && (
                                    <Alert
                                        message={connector.errorMessage}
                                        type="error"
                                        showIcon
                                        style={{ marginTop: 8 }}
                                    />
                                )}

                                {/* Last Checked */}
                                {connector.lastChecked && (
                                    <Text type="secondary" style={{ fontSize: 11 }}>
                                        Last checked: {connector.lastChecked.toLocaleTimeString()}
                                    </Text>
                                )}
                            </Space>
                        </Card>
                    );
                })}
            </Space>
        </div>
    );
};
