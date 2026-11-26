/**
 * Canvas node & edge definitions + shared visual styles.
 * All nodes use the custom 'connectorNode' type for status indicators.
 */
import React from 'react';
import { Node, Edge } from '@xyflow/react';
import { Space } from 'antd';
import { FileTextOutlined, SafetyCertificateOutlined, RobotOutlined } from '@ant-design/icons';
import type { ConnectorNodeData } from './ConnectorNode';
import { BRAND } from '../../../theme';

// ── Visual Styles ────────────────────────────────────────────────────
// Geometry only. Colors are applied at render time from theme tokens
// (useCanvasEnrichedNodes), so they follow light/dark mode and override any
// colors persisted with older saved canvases.

export const sourceStyle = { width: 180, borderRadius: 8 };
export const targetStyle = { width: 180, borderRadius: 8 };
export const edgeStyle = { stroke: BRAND.edgeStroke, strokeWidth: 1.5 };

export const brainStyle = {
  width: 190,
  borderRadius: 12,
  height: 60,
  display: 'flex' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};

// ── Brain Node ───────────────────────────────────────────────────────
// Edges, the Brain drawer (Identity Correlation, field mastery) and connectorConfigs find the
// Brain by this id. React Flow deletes a selected node on Backspace and no UI adds the Brain
// back: the canvas renders it not deletable (useCanvasEnrichedNodes), and a loaded canvas
// without one gets it back (withBrainNode).

const BRAIN_ID = 'euroid-core';

const brainNode: Node<ConnectorNodeData> = {
  id: BRAIN_ID,
  type: 'connectorNode',
  data: {
    label: (
      <Space>
        <RobotOutlined /> EuroID Brain
      </Space>
    ),
    role: 'brain',
  },
  position: { x: 350, y: 250 },
  style: brainStyle,
};

/**
 * A loaded canvas with its Brain: as saved, or with the default Brain added when it has none
 * (a canvas saved after the Brain was deleted).
 */
export function withBrainNode(nodes: Node[]): Node[] {
  const hasBrain = nodes.some((n) => n.id === BRAIN_ID || n.data?.role === 'brain');
  return hasBrain ? nodes : [...nodes, { ...brainNode }];
}

// ── Initial Nodes (all use 'connectorNode' custom type) ──────────────
// Default canvas for a tenant with no saved blueprint. Only connectors the
// backend registers (see shared/connector-registry.ts); node ids must match
// their registry idPatterns, and data.type is the connector's backend id:
// onboarding finds its targets by it (getActiveTargetSystems).

export const initialNodes: Node<ConnectorNodeData>[] = [
  {
    id: 'csv-hr-source',
    type: 'connectorNode',
    data: {
      label: (
        <Space>
          <FileTextOutlined /> CSV HR
        </Space>
      ),
      role: 'source',
      type: 'csv-hr',
    },
    position: { x: 50, y: 250 },
    style: sourceStyle,
  },
  brainNode,
  {
    id: 'entra-target',
    type: 'connectorNode',
    data: {
      label: (
        <Space>
          <SafetyCertificateOutlined /> Microsoft Entra ID
        </Space>
      ),
      role: 'target',
      type: 'entra-id',
      healthStatus: 'unknown',
    },
    position: { x: 700, y: 250 },
    style: targetStyle,
  },
];

// ── Initial Edges ────────────────────────────────────────────────────

export const initialEdges: Edge[] = [
  {
    id: 'e1-core',
    source: 'csv-hr-source',
    target: 'euroid-core',
    style: edgeStyle,
    label: 'HR Feed',
  },
  {
    id: 'core-entra',
    source: 'euroid-core',
    target: 'entra-target',
    style: edgeStyle,
    label: 'Identity',
  },
];
