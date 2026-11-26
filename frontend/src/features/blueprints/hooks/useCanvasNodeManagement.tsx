/**
 * useCanvasNodeManagement — Node/edge CRUD, drag-drop and click-to-add of policy nodes, policy draft routing.
 * Connector add/delete logic extracted to useConnectorActions.
 */
import React, { useState, useCallback } from 'react';
import {
  applyNodeChanges,
  applyEdgeChanges,
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  Dimensions,
} from '@xyflow/react';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import { useConnectorActions } from './useConnectorActions';
import type { EdgeFlowData } from '../types/edge-condition.types';
import type { PolicyNodeTemplate } from '../types/blueprint-canvas.types';
import { DEFAULT_NODE_SIZE, freePosition, nodeBox } from '../utils/free-position';

export interface UseCanvasNodeManagementParams {
  api: ReturnType<typeof import('antd').notification.useNotification>[0];
  reactFlowRef: React.RefObject<{
    screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
  } | null>;
  /** The canvas element; click-to-add places a node at its center. */
  canvasRef?: React.RefObject<HTMLElement | null>;
  onConnectorDeleted?: (nodeId: string) => void;
}

export function useCanvasNodeManagement({
  api,
  reactFlowRef,
  canvasRef,
  onConnectorDeleted,
}: UseCanvasNodeManagementParams) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [edgePopover, setEdgePopover] = useState<{
    edgeId: string;
    edgeData: EdgeFlowData;
    position: { x: number; y: number };
  } | null>(null);
  // React Flow's MiniMap draws a node only when the node object it was given
  // carries a `measured` size. Policy nodes come from the draft store, which a
  // canvas measurement must not change or mark dirty, so their sizes live here.
  const [draftNodeSizes, setDraftNodeSizes] = useState<Record<string, Dimensions>>({});

  const {
    draftNodes,
    draftEdges,
    addNode: addDraftNode,
    removeNode: removeDraftNode,
    updateNode: updateDraftNode,
    addEdge: addDraftEdge,
    removeEdge: removeDraftEdge,
  } = usePolicyDraftStore();

  const isPolicyNode = useCallback(
    (id: string) => draftNodes.some((n) => n.id === id),
    [draftNodes],
  );
  const isPolicyEdge = useCallback(
    (id: string) => draftEdges.some((e) => e.id === id),
    [draftEdges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const connectorChanges: NodeChange[] = [];
      const policySizes: Record<string, Dimensions> = {};
      for (const ch of changes) {
        if (ch.type === 'dimensions' && ch.dimensions && isPolicyNode(ch.id)) {
          policySizes[ch.id] = ch.dimensions;
          continue;
        }
        if (ch.type === 'position' && 'id' in ch && ch.position) {
          if (isPolicyNode(ch.id as string)) {
            updateDraftNode(ch.id as string, { position: ch.position });
            continue;
          }
        }
        if (ch.type === 'remove' && 'id' in ch) {
          if (isPolicyNode(ch.id as string)) {
            removeDraftNode(ch.id as string);
            continue;
          }
        }
        connectorChanges.push(ch);
      }
      if (Object.keys(policySizes).length > 0) {
        setDraftNodeSizes((prev) => ({ ...prev, ...policySizes }));
      }
      // Dimension changes give connector nodes their `measured` size, which the
      // MiniMap needs to draw them.
      if (connectorChanges.some((c) => c.type !== 'select')) {
        setNodes((nds) => applyNodeChanges(connectorChanges, nds));
      }
    },
    [isPolicyNode, updateDraftNode, removeDraftNode],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const connectorChanges: EdgeChange[] = [];
      for (const ch of changes) {
        if (ch.type === 'remove' && 'id' in ch && isPolicyEdge(ch.id as string)) {
          removeDraftEdge(ch.id as string);
          continue;
        }
        if (ch.type === 'add' && 'item' in ch) {
          const edge = ch.item as Edge;
          if (
            draftNodes.some((n) => n.id === edge.source) &&
            draftNodes.some((n) => n.id === edge.target)
          ) {
            addDraftEdge({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              data: (edge.data as Record<string, unknown>) || {},
            });
            continue;
          }
        }
        connectorChanges.push(ch);
      }
      if (connectorChanges.length > 0) setEdges((eds) => applyEdgeChanges(connectorChanges, eds));
    },
    [isPolicyEdge, draftNodes, addDraftEdge, removeDraftEdge],
  );

  const onConnect = useCallback(
    (params: { source: string | null; target: string | null }) => {
      if (!params.source || !params.target) return;
      const isPolicy =
        draftNodes.some((n) => n.id === params.source) &&
        draftNodes.some((n) => n.id === params.target);
      const edgeId = `e-${params.source}-${params.target}-${Date.now()}`;
      if (isPolicy) {
        addDraftEdge({ id: edgeId, source: params.source, target: params.target });
      } else {
        setEdges((eds) => [...eds, { id: edgeId, source: params.source!, target: params.target! }]);
      }
    },
    [draftNodes, addDraftEdge],
  );

  /**
   * Add a policy node with its top-left corner at a screen point: where it is dropped, or for
   * click-to-add at the canvas center, moved straight down when it would cover another node there
   * (the Brain sits at the center).
   */
  const addPolicyNodeAt = useCallback(
    ({ type, data }: PolicyNodeTemplate, point: { x: number; y: number }, keepClear = false) => {
      if (!reactFlowRef.current) return;
      let position = reactFlowRef.current.screenToFlowPosition(point);
      if (keepClear) {
        const occupied = [
          ...nodes.map((n) => nodeBox(n)),
          ...draftNodes.map((n) => nodeBox(n, draftNodeSizes[n.id])),
        ];
        position = freePosition(position, DEFAULT_NODE_SIZE, occupied);
      }
      const base = `${type}-${Date.now()}`;
      let id = base;
      for (let i = 1; draftNodes.some((n) => n.id === id); i++) id = `${base}-${i}`;
      addDraftNode({ id, type, position, data: { ...data } });
    },
    [addDraftNode, draftNodes, draftNodeSizes, nodes, reactFlowRef],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const rawData = event.dataTransfer.getData('application/reactflow');
      if (!rawData) return;
      try {
        const { type, data } = JSON.parse(rawData);
        if (type !== 'condition' && type !== 'action') return;
        addPolicyNodeAt({ type, data: data || {} }, { x: event.clientX, y: event.clientY });
      } catch {
        /* Ignore invalid drop data */
      }
    },
    [addPolicyNodeAt],
  );

  /** The keyboard and click alternative to dragging: add at the center of the visible canvas. */
  const addPolicyNodeAtCenter = useCallback(
    (template: PolicyNodeTemplate) => {
      const rect = canvasRef?.current?.getBoundingClientRect();
      if (!rect) return;
      addPolicyNodeAt(
        template,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        true,
      );
    },
    [addPolicyNodeAt, canvasRef],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    if (edge.source !== 'euroid-core') return;
    setEdgePopover({
      edgeId: edge.id,
      edgeData: (edge.data || {}) as EdgeFlowData,
      position: { x: event.clientX, y: event.clientY },
    });
  }, []);

  const handleEdgeConditionSave = useCallback((edgeId: string, data: EdgeFlowData) => {
    setEdges((prev) => prev.map((e) => (e.id === edgeId ? { ...e, data } : e)));
    setEdgePopover(null);
  }, []);

  const { handleAddSystem, handleDeleteConnector, addConnectorItems } = useConnectorActions({
    api,
    nodes,
    edges,
    setNodes,
    setEdges,
    setSelectedNode,
    onConnectorDeleted,
  });

  return {
    nodes,
    setNodes,
    edges,
    setEdges,
    selectedNode,
    setSelectedNode,
    edgePopover,
    setEdgePopover,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onDrop,
    onDragOver,
    onEdgeClick,
    addPolicyNodeAtCenter,
    handleEdgeConditionSave,
    handleAddSystem,
    handleDeleteConnector,
    addConnectorItems,
    draftNodes,
    draftEdges,
    draftNodeSizes,
  };
}
