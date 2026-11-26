/**
 * useConnectorActions — Add/delete connector logic + dropdown menu items.
 * Extracted from useCanvasNodeManagement to keep files under 250 lines.
 */
import React, { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Node, Edge } from '@xyflow/react';
import { Space } from 'antd';
import { ShopOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { buildNewConnector, removeConnector } from '../canvas';
import type { HealthStatus } from '../canvas';
import { SOURCE_CONNECTORS, TARGET_CONNECTORS, getConnectorIcon } from '../shared';
import { useConnectorStore } from '@stores/connector-store';

export interface UseConnectorActionsParams {
    api: ReturnType<typeof import('antd').notification.useNotification>[0];
    nodes: Node[];
    edges: Edge[];
    setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
    setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
    setSelectedNode: (node: Node | null) => void;
    onConnectorDeleted?: (nodeId: string) => void;
}

export function useConnectorActions({
    api, nodes, edges, setNodes, setEdges, setSelectedNode, onConnectorDeleted,
}: UseConnectorActionsParams) {
    const navigate = useNavigate();
    const { isInstalled: isConnectorInstalled, installed: installedConnectors, ensureSynced } = useConnectorStore();
    // A fresh browser has no persisted install list, so load it from the backend
    // unless this page session already has it (the Marketplace page loads it too).
    useEffect(() => {
        ensureSynced();
    }, [ensureSynced]);
    const installedSources = SOURCE_CONNECTORS.filter((c) => isConnectorInstalled(c.id ?? c.name));
    const installedTargets = TARGET_CONNECTORS.filter((c) => isConnectorInstalled(c.id ?? c.name));
    const hasInstalledConnectors = installedConnectors.length > 0;

    const handleAddSystem = useCallback(
        (name: string, direction: 'source' | 'target', connectorId?: string) => {
            const icon = getConnectorIcon(name);
            const { node, edge } = buildNewConnector(name, direction, icon, nodes);
            const systemType = connectorId ?? name.toLowerCase().replace(/microsoft\s+/i, '').replace(/\s+/g, '-').replace(/\(.*?\)/g, '').trim();
            node.data = {
                label: <Space>{icon} {name}</Space>,
                role: direction === 'source' ? 'source' : 'target',
                type: systemType,
                ...(direction === 'source' ? { pipelineCount: 0 } : { healthStatus: 'unknown' as HealthStatus }),
            };
            setNodes((nds) => [...nds, node]);
            setEdges((eds) => [...eds, edge]);
            api.success({
                message: direction === 'source' ? 'Source Connected' : 'Integration Added',
                description: direction === 'source'
                    ? `${name} source connected to the Brain. Data will flow automatically.`
                    : `${name} connector installed. Policies automatically applied.`,
                placement: 'top',
            });
        },
        [nodes, api, setNodes, setEdges]
    );

    const handleDeleteConnector = useCallback(
        (nodeId: string) => {
            const result = removeConnector(nodeId, nodes, edges);
            setNodes(result.nodes);
            setEdges(result.edges);
            setSelectedNode(null);
            onConnectorDeleted?.(nodeId);
            api.success({ message: 'Connector Removed', description: 'Connector removed from the canvas. You can re-add it from "Add Connector".', placement: 'top' });
        },
        [nodes, edges, api, onConnectorDeleted, setNodes, setEdges, setSelectedNode]
    );

    const addConnectorItems: MenuProps['items'] = hasInstalledConnectors
        ? [
            ...(installedSources.length > 0 ? [{ key: 'src-header', label: 'Sources (Input)', type: 'group' as const, children: installedSources.map((c, i) => ({ key: `s${i}`, label: c.name, icon: c.icon, onClick: () => handleAddSystem(c.name, 'source', c.id) })) }] : []),
            ...(installedSources.length > 0 && installedTargets.length > 0 ? [{ type: 'divider' as const }] : []),
            ...(installedTargets.length > 0 ? [{ key: 'tgt-header', label: 'Targets (Output)', type: 'group' as const, children: installedTargets.map((c, i) => ({ key: `t${i}`, label: c.name, icon: c.icon, onClick: () => handleAddSystem(c.name, 'target', c.id) })) }] : []),
        ]
        : [
            { key: 'hint', label: 'Install from Connector Marketplace first', disabled: true },
            { type: 'divider' as const },
            { key: 'go-marketplace', label: 'Go to Connector Marketplace', icon: <ShopOutlined />, onClick: () => navigate('/connectors') },
        ];

    return { handleAddSystem, handleDeleteConnector, addConnectorItems };
}
