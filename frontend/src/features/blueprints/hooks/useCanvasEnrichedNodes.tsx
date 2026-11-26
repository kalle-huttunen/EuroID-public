/**
 * useCanvasEnrichedNodes — Enrich nodes/edges with per-source user counts, health,
 * conditions and theme-driven styling, including the LIVE state of a deployed pipeline.
 * Extracted from BlueprintCanvas for separation of concerns.
 *
 * LIVE (pipelineStatus === 'DEPLOYED'): source -> brain -> target edges get the
 * `edge-live` class (slow dash flow, src/styles/app.css) in EU gold, the brain a
 * soft gold glow, online target health dots a gentle pulse. Paused or stopped:
 * everything static, so motion itself signals the live state.
 */
import type React from 'react';
import { useMemo } from 'react';
import { Node, Edge, Dimensions } from '@xyflow/react';
import { getEdgeConditionTooltip } from '../EdgeConditionPopover';
import type { EdgeFlowData } from '../types/edge-condition.types';
import type { HealthStatus } from '../canvas';
import { LIVE } from '../../../theme';

/** Theme colors the canvas needs; pass values from `theme.useToken()`. */
export interface CanvasPalette {
  surface: string;
  border: string;
  text: string;
  textSecondary: string;
  primary: string;
  primaryBg: string;
  edge: string;
  shadow: string;
}

export interface UseCanvasEnrichedNodesParams {
  nodes: Node[];
  edges: Edge[];
  /** Users per source node id (canvas/source-counts.ts). No entry: no badge or edge count. */
  sourceCounts: Record<string, number>;
  connectorHealth: Record<string, HealthStatus>;
  draftNodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>;
  draftEdges: Array<{ id: string; source: string; target: string; data?: Record<string, unknown> }>;
  /** Size React Flow measured for each policy draft node; the MiniMap skips a node without one. */
  draftNodeSizes: Record<string, Dimensions>;
  colorPrimary: string;
  palette: CanvasPalette;
  /** True while the pipeline is DEPLOYED. */
  live: boolean;
}

const BRAIN_ID = 'euroid-core';

function nodeStyle(role: unknown, palette: CanvasPalette, live: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    background: palette.surface,
    color: palette.text,
    border: `1px solid ${palette.border}`,
    boxShadow: palette.shadow,
  };
  if (role !== 'brain') return base;
  return {
    ...base,
    background: palette.primaryBg,
    border: `1.5px solid ${live ? LIVE.color : palette.primary}`,
    boxShadow: live ? `0 0 0 4px ${LIVE.glowSoft}, 0 0 28px ${LIVE.glow}` : palette.shadow,
    fontWeight: 600,
  };
}

export function useCanvasEnrichedNodes({
  nodes,
  edges,
  sourceCounts,
  connectorHealth,
  draftNodes,
  draftEdges,
  draftNodeSizes,
  colorPrimary,
  palette,
  live,
}: UseCanvasEnrichedNodesParams) {
  const enrichedNodes = useMemo(
    () =>
      nodes.map((n) => {
        const role = n.data?.role;
        const style = { ...n.style, ...nodeStyle(role, palette, live) };
        if (role === 'source') {
          return { ...n, style, data: { ...n.data, pipelineCount: sourceCounts[n.id], live } };
        }
        if (role === 'target') {
          return {
            ...n,
            style,
            data: { ...n.data, healthStatus: connectorHealth[n.id] || 'unknown', live },
          };
        }
        // React Flow deletes a selected node on Backspace, and nothing adds the Brain back. Set
        // here, where every node reaches React Flow, it stays out of the saved canvas.
        if (role === 'brain') return { ...n, style, deletable: false, data: { ...n.data, live } };
        return n;
      }),
    [nodes, sourceCounts, connectorHealth, palette, live],
  );

  const enrichedEdges = useMemo(
    () =>
      edges.map((e) => {
        const sourceNode = nodes.find((n) => n.id === e.source);
        const flowData = (e.data || {}) as EdgeFlowData;
        const hasActiveConditions =
          flowData.conditionsEnabled && (flowData.conditionGroups?.length ?? 0) > 0;
        const isPipelineEdge = e.target === BRAIN_ID || e.source === BRAIN_ID;
        const liveEdge = live && isPipelineEdge;

        const themed: Edge = {
          ...e,
          className: liveEdge ? 'edge-live' : undefined,
          style: {
            ...e.style,
            stroke: liveEdge ? LIVE.color : palette.edge,
            strokeWidth: liveEdge ? 2 : 1.5,
          },
          labelStyle: { fill: palette.textSecondary, fontSize: 11, fontWeight: 500 },
          labelBgStyle: { fill: palette.surface },
          labelBgPadding: [6, 3],
          labelBgBorderRadius: 4,
        };

        const sourceCount = sourceCounts[e.source] ?? 0;
        if (sourceNode?.data?.role === 'source' && e.target === BRAIN_ID && sourceCount > 0) {
          return { ...themed, label: `${e.label || 'Data Feed'} (${sourceCount})` };
        }
        if (e.source === BRAIN_ID && hasActiveConditions) {
          const baseLabel = typeof e.label === 'string' ? e.label : e.label ? 'Flow' : '';
          const labelText = `${baseLabel || 'Flow'} (filtered)`;
          // Edge labels render as SVG <text>, so they must be plain strings (an HTML
          // tooltip here renders nothing). The full condition is shown on edge click.
          const tooltipText = getEdgeConditionTooltip(flowData);
          return {
            ...themed,
            data: flowData,
            label: labelText,
            ariaLabel: tooltipText ? `${labelText}: ${tooltipText}` : labelText,
            style: liveEdge
              ? themed.style
              : { ...themed.style, strokeDasharray: '6 4', stroke: colorPrimary },
          };
        }
        return themed;
      }),
    [edges, nodes, sourceCounts, colorPrimary, palette, live],
  );

  const policyDraftNodesAsRf = useMemo(
    () =>
      draftNodes.map((n) => ({
        id: n.id,
        type: n.type as 'condition' | 'action',
        position: n.position,
        data: n.data,
        measured: draftNodeSizes[n.id],
      })),
    [draftNodes, draftNodeSizes],
  );
  const policyDraftEdgesAsRf = useMemo(
    () =>
      draftEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        data: e.data,
      })),
    [draftEdges],
  );

  const allNodes = useMemo(
    () => [...enrichedNodes, ...policyDraftNodesAsRf],
    [enrichedNodes, policyDraftNodesAsRf],
  );
  const allEdges = useMemo(
    () => [...enrichedEdges, ...policyDraftEdgesAsRf],
    [enrichedEdges, policyDraftEdgesAsRf],
  );

  return { allNodes, allEdges };
}
