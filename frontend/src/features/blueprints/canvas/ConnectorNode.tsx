/**
 * ConnectorNode -- Custom ReactFlow node with status indicators.
 *
 * Three roles:
 *   source -- green pipeline badge (user count) at top-right; priority label (P1/P2) when configured
 *   brain  -- no extra indicators, just the label
 *   target -- health status dot at top-right (green/red/grey)
 *
 * Uses <Handle> for side-connected edges (left/right).
 */
import React, { memo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { Tooltip, theme } from 'antd';

export type HealthStatus = 'unknown' | 'checking' | 'online' | 'offline';
export type NodeRole = 'source' | 'brain' | 'target';

export interface ConnectorNodeData {
    [key: string]: unknown;
    label: React.ReactNode;
    role: NodeRole;
    type?: string; // System type identifier (e.g., 'entra-id', 'csv-hr')
    pipelineCount?: number;
    healthStatus?: HealthStatus;
    /** Priority label for source nodes (e.g. "P1 (Primary)") — set from connector config */
    priorityLabel?: string;
    /** Pipeline is DEPLOYED: online health dots pulse (presentation only, not persisted) */
    live?: boolean;
    // Configuration fields (persisted to backend)
    config?: {
        // Common fields
        endpoint?: string;
        apiKey?: string;
        // Entra ID specific
        tenantId?: string;
        clientId?: string;
        clientSecret?: string;
        // HR/Workday specific
        hrUrl?: string;
        syncFrequency?: string;
        // Generic extensible config
        [key: string]: unknown;
    };
}

const healthLabels: Record<HealthStatus, string> = {
    unknown: 'Not checked',
    checking: 'Checking...',
    online: 'Connected',
    offline: 'Unreachable',
};

// ── Component ────────────────────────────────────────────────────────

const ConnectorNodeComponent: React.FC<NodeProps<Node<ConnectorNodeData, 'connectorNode'>>> = ({ data }) => {
    const { token } = theme.useToken();
    const { label, role, pipelineCount, healthStatus = 'unknown', priorityLabel: dataPriorityLabel, config, live } = data;

    const priorityLabel =
        dataPriorityLabel ??
        (role === 'source' && config?.ingestPriority != null
            ? `P${config.ingestPriority}${config.contractTag === 'SECONDARY' ? ' (Secondary)' : ' (Primary)'}`
            : undefined);

    const healthColors: Record<HealthStatus, string> = {
        unknown: token.colorBorder,
        checking: token.colorWarning,
        online: token.colorSuccess,
        offline: token.colorError,
    };

    // Handle label rendering - support both JSX and plain objects
    const renderLabel = () => {
        // If it's already valid JSX, render it
        if (React.isValidElement(label)) {
            return label;
        }
        
        // If it's a string, render it directly
        if (typeof label === 'string') {
            return label;
        }
        
        // If it's an object (serialized JSX), try to extract the text
        if (label && typeof label === 'object') {
            const labelObj = label as { props?: { children?: unknown } };
            if (labelObj.props?.children) {
                const children = labelObj.props.children;
                if (Array.isArray(children)) {
                    // Extract text from array (e.g., [<Icon />, " Text"])
                    return children
                        .filter(c => typeof c === 'string')
                        .join('')
                        .trim();
                }
                if (typeof children === 'string') {
                    return children;
                }
            }
            
            // Fallback: try to stringify
            return JSON.stringify(label);
        }
        
        return 'Unnamed Node';
    };

    return (
        <div style={{ position: 'relative' }}>
            {/* Left handle (for brain + target nodes) */}
            {(role === 'brain' || role === 'target') && (
                <Handle type="target" position={Position.Left} />
            )}

            {/* Right handle (for brain + source nodes) */}
            {(role === 'brain' || role === 'source') && (
                <Handle type="source" position={Position.Right} />
            )}

            {/* Node label */}
            <div style={{ padding: '8px 12px', fontSize: 13, position: 'relative' }}>
                {renderLabel()}
                {role === 'source' && priorityLabel && (
                    <Tooltip title="Ingest priority from connector config">
                        <span
                            style={{
                                position: 'absolute',
                                top: -18,
                                left: 4,
                                fontSize: 10,
                                fontWeight: 600,
                                lineHeight: '16px',
                                color: token.colorTextSecondary,
                                background: token.colorBgContainer,
                                border: `1px solid ${token.colorBorder}`,
                                padding: '0 6px',
                                borderRadius: 4,
                                whiteSpace: 'nowrap',
                            }}
                        >
                            {priorityLabel}
                        </span>
                    </Tooltip>
                )}
            </div>

            {/* Pipeline badge (source nodes only) */}
            {role === 'source' && pipelineCount != null && pipelineCount > 0 && (
                <Tooltip title={`${pipelineCount} users in pipeline`}>
                    <div style={{
                        position: 'absolute',
                        top: -8,
                        right: -8,
                        background: token.colorSuccess,
                        color: token.colorTextLightSolid,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 10,
                        lineHeight: '16px',
                        boxShadow: token.boxShadowSecondary,
                        whiteSpace: 'nowrap',
                    }}>
                        {pipelineCount} users
                    </div>
                </Tooltip>
            )}

            {/* Health status dot (target nodes only) */}
            {role === 'target' && (
                <Tooltip title={healthLabels[healthStatus as HealthStatus]}>
                    <div
                        className={live && healthStatus === 'online' ? 'health-dot-live' : undefined}
                        role="img"
                        aria-label={`Health: ${healthLabels[healthStatus as HealthStatus]}`}
                        style={{
                            position: 'absolute',
                            top: -4,
                            right: -4,
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: healthColors[healthStatus as HealthStatus],
                            color: healthColors[healthStatus as HealthStatus],
                            border: `2px solid ${token.colorBgContainer}`,
                            cursor: 'default',
                        }}
                    />
                </Tooltip>
            )}
        </div>
    );
};

export const ConnectorNode = memo(ConnectorNodeComponent);
