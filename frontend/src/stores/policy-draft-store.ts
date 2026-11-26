/**
 * Policy Draft Store — Zustand store for visual policy builder.
 * Tracks nodes, edges, validation, simulation state. Not persisted in the browser: the
 * Design studio saves the nodes and edges with the canvas (POST /blueprints/save) and
 * loads them back with loadDraft.
 */
import { create } from 'zustand';

export interface PolicyNode {
  id: string;
  type: 'condition' | 'action' | 'brain' | 'connector';
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface PolicyEdge {
  id: string;
  source: string;
  target: string;
  data?: {
    condition?: string;
    operator?: string;
    value?: string;
  };
}

export interface SimulationResult {
  totalAffected: number;
  usersGainingAccess: number;
  usersLosingAccess: number;
  usersUnchanged: number;
  affectedUsers: Array<{
    identityId: string;
    name: string;
    changes: Array<{ type: 'grant' | 'revoke'; entitlement: string; connector: string }>;
  }>;
  riskScore: number;
  timestamp: string;
  /** Backend format: matchedCount, matchedUsers, actionsBySystem, totalOperations */
  matchedCount?: number;
  matchedUsers?: Array<Record<string, unknown>>;
  actionsBySystem?: Record<string, number>;
  totalOperations?: number;
  totalUsers?: number;
}

export interface ValidationError {
  nodeId: string;
  field: string;
  message: string;
}

interface PolicyDraftState {
  draftNodes: PolicyNode[];
  draftEdges: PolicyEdge[];
  isDirty: boolean;
  isSaving: boolean;
  isSimulating: boolean;
  simulationResult: SimulationResult | null;
  validationErrors: ValidationError[];
  lastSavedAt: string | null;

  setNodes: (nodes: PolicyNode[]) => void;
  setEdges: (edges: PolicyEdge[]) => void;
  /** Replace the draft with the saved canvas's policy nodes and edges; the draft is clean. */
  loadDraft: (nodes: PolicyNode[], edges: PolicyEdge[]) => void;
  addNode: (node: PolicyNode) => void;
  removeNode: (nodeId: string) => void;
  updateNode: (nodeId: string, data: Partial<PolicyNode>) => void;
  addEdge: (edge: PolicyEdge) => void;
  removeEdge: (edgeId: string) => void;
  markClean: () => void;
  setSimulationResult: (result: SimulationResult | null) => void;
  setValidationErrors: (errors: ValidationError[]) => void;
  validate: () => ValidationError[];
  reset: () => void;
}

export const usePolicyDraftStore = create<PolicyDraftState>((set, get) => ({
  draftNodes: [],
  draftEdges: [],
  isDirty: false,
  isSaving: false,
  isSimulating: false,
  simulationResult: null,
  validationErrors: [],
  lastSavedAt: null,

  setNodes: (nodes) => set({ draftNodes: nodes, isDirty: true }),
  setEdges: (edges) => set({ draftEdges: edges, isDirty: true }),

  loadDraft: (nodes, edges) =>
    set({
      draftNodes: nodes,
      draftEdges: edges,
      isDirty: false,
      simulationResult: null,
      validationErrors: [],
    }),

  addNode: (node) =>
    set((state) => ({
      draftNodes: [...state.draftNodes, node],
      isDirty: true,
      simulationResult: null,
    })),

  removeNode: (nodeId) =>
    set((state) => ({
      draftNodes: state.draftNodes.filter((n) => n.id !== nodeId),
      draftEdges: state.draftEdges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      isDirty: true,
      simulationResult: null,
    })),

  updateNode: (nodeId, data) =>
    set((state) => ({
      draftNodes: state.draftNodes.map((n) => (n.id === nodeId ? { ...n, ...data } : n)),
      isDirty: true,
      simulationResult: null,
    })),

  addEdge: (edge) =>
    set((state) => ({
      draftEdges: [...state.draftEdges, edge],
      isDirty: true,
    })),

  removeEdge: (edgeId) =>
    set((state) => ({
      draftEdges: state.draftEdges.filter((e) => e.id !== edgeId),
      isDirty: true,
    })),

  markClean: () => set({ isDirty: false, lastSavedAt: new Date().toISOString() }),

  setSimulationResult: (result) => set({ simulationResult: result, isSimulating: false }),

  setValidationErrors: (errors) => set({ validationErrors: errors }),

  validate: () => {
    const { draftNodes, draftEdges } = get();
    const errors: ValidationError[] = [];

    for (const node of draftNodes) {
      if (node.type === 'condition') {
        if (!node.data.field)
          errors.push({ nodeId: node.id, field: 'field', message: 'Condition field is required' });
        if (!node.data.operator)
          errors.push({ nodeId: node.id, field: 'operator', message: 'Operator is required' });
        if (!node.data.value)
          errors.push({ nodeId: node.id, field: 'value', message: 'Value is required' });
      }
      if (node.type === 'action') {
        if (!node.data.targetSystem)
          errors.push({ nodeId: node.id, field: 'targetSystem', message: 'Target system is required' });
        if (!node.data.actionType)
          errors.push({ nodeId: node.id, field: 'actionType', message: 'Action type is required' });
      }
    }

    const conditionNodes = draftNodes.filter((n) => n.type === 'condition');
    for (const cond of conditionNodes) {
      const hasOutgoing = draftEdges.some((e) => e.source === cond.id);
      if (!hasOutgoing) {
        errors.push({
          nodeId: cond.id,
          field: 'edges',
          message: 'Condition must connect to an action',
        });
      }
    }

    set({ validationErrors: errors });
    return errors;
  },

  reset: () =>
    set({
      draftNodes: [],
      draftEdges: [],
      isDirty: false,
      simulationResult: null,
      validationErrors: [],
    }),
}));
