import { describe, it, expect, beforeEach } from 'vitest';
import { usePolicyDraftStore } from '../policy-draft-store';

describe('policy-draft-store', () => {
  beforeEach(() => {
    usePolicyDraftStore.getState().reset();
  });

  it('addNode adds node and sets isDirty', () => {
    const { addNode, draftNodes, isDirty } = usePolicyDraftStore.getState();
    addNode({
      id: 'cond-1',
      type: 'condition',
      data: { field: 'department', operator: 'equals', value: 'Sales' },
      position: { x: 0, y: 0 },
    });
    const state = usePolicyDraftStore.getState();
    expect(state.draftNodes).toHaveLength(1);
    expect(state.draftNodes[0].id).toBe('cond-1');
    expect(state.isDirty).toBe(true);
  });

  it('removeNode removes node and its connected edges', () => {
    const { addNode, addEdge, removeNode } = usePolicyDraftStore.getState();
    addNode({
      id: 'cond-1',
      type: 'condition',
      data: { field: 'dept', operator: 'equals', value: 'A' },
      position: { x: 0, y: 0 },
    });
    addNode({
      id: 'act-1',
      type: 'action',
      data: { targetSystem: 'entra-id', actionType: 'assign_group' },
      position: { x: 200, y: 0 },
    });
    addEdge({ id: 'e1', source: 'cond-1', target: 'act-1' });
    removeNode('cond-1');
    const state = usePolicyDraftStore.getState();
    expect(state.draftNodes).toHaveLength(1);
    expect(state.draftNodes[0].id).toBe('act-1');
    expect(state.draftEdges).toHaveLength(0);
  });

  it('updateNode updates node data', () => {
    const { addNode, updateNode } = usePolicyDraftStore.getState();
    addNode({
      id: 'cond-1',
      type: 'condition',
      data: { field: 'dept', operator: 'equals', value: 'A' },
      position: { x: 0, y: 0 },
    });
    updateNode('cond-1', { data: { field: 'department', value: 'Engineering' } });
    const state = usePolicyDraftStore.getState();
    expect(state.draftNodes[0].data.field).toBe('department');
    expect(state.draftNodes[0].data.value).toBe('Engineering');
  });

  it('addEdge / removeEdge work correctly', () => {
    const { addNode, addEdge, removeEdge } = usePolicyDraftStore.getState();
    addNode({
      id: 'c1',
      type: 'condition',
      data: {},
      position: { x: 0, y: 0 },
    });
    addNode({
      id: 'a1',
      type: 'action',
      data: {},
      position: { x: 100, y: 0 },
    });
    addEdge({ id: 'e1', source: 'c1', target: 'a1' });
    expect(usePolicyDraftStore.getState().draftEdges).toHaveLength(1);
    removeEdge('e1');
    expect(usePolicyDraftStore.getState().draftEdges).toHaveLength(0);
  });

  it('validate() catches missing condition fields (field, operator, value)', () => {
    const { addNode, validate } = usePolicyDraftStore.getState();
    addNode({
      id: 'c1',
      type: 'condition',
      data: {},
      position: { x: 0, y: 0 },
    });
    const errors = validate();
    expect(errors).toContainEqual(
      expect.objectContaining({
        nodeId: 'c1',
        field: 'field',
        message: 'Condition field is required',
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ nodeId: 'c1', field: 'operator', message: 'Operator is required' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ nodeId: 'c1', field: 'value', message: 'Value is required' }),
    );
  });

  it('validate() catches missing action fields (targetSystem, actionType)', () => {
    const { addNode, validate } = usePolicyDraftStore.getState();
    addNode({
      id: 'a1',
      type: 'action',
      data: {},
      position: { x: 0, y: 0 },
    });
    const errors = validate();
    expect(errors).toContainEqual(
      expect.objectContaining({
        nodeId: 'a1',
        field: 'targetSystem',
        message: 'Target system is required',
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        nodeId: 'a1',
        field: 'actionType',
        message: 'Action type is required',
      }),
    );
  });

  it('validate() catches disconnected condition nodes (no outgoing edge)', () => {
    const { addNode, validate } = usePolicyDraftStore.getState();
    addNode({
      id: 'c1',
      type: 'condition',
      data: { field: 'dept', operator: 'equals', value: 'A' },
      position: { x: 0, y: 0 },
    });
    const errors = validate();
    expect(errors).toContainEqual(
      expect.objectContaining({
        nodeId: 'c1',
        field: 'edges',
        message: 'Condition must connect to an action',
      }),
    );
  });

  it('validate() passes a complete graph and clears the errors of an earlier check', () => {
    const { addNode, updateNode, addEdge, validate } = usePolicyDraftStore.getState();
    addNode({ id: 'c1', type: 'condition', data: { field: 'dept' }, position: { x: 0, y: 0 } });
    expect(validate()).not.toEqual([]);
    expect(usePolicyDraftStore.getState().validationErrors).not.toEqual([]);

    updateNode('c1', { data: { field: 'dept', operator: 'equals', value: 'A' } });
    addNode({
      id: 'a1',
      type: 'action',
      data: { targetSystem: 'entra-id', actionType: 'assign_group' },
      position: { x: 200, y: 0 },
    });
    addEdge({ id: 'c1-a1', source: 'c1', target: 'a1' });

    expect(validate()).toEqual([]);
    expect(usePolicyDraftStore.getState().validationErrors).toEqual([]);
  });

  it('setSimulationResult clears isSimulating', () => {
    usePolicyDraftStore.setState({ isSimulating: true });
    usePolicyDraftStore.getState().setSimulationResult({
      totalAffected: 5,
      usersGainingAccess: 3,
      usersLosingAccess: 1,
      usersUnchanged: 1,
      affectedUsers: [],
      riskScore: 50,
      timestamp: new Date().toISOString(),
    });
    const state = usePolicyDraftStore.getState();
    expect(state.isSimulating).toBe(false);
    expect(state.simulationResult).not.toBeNull();
  });

  it('addNode clears stale simulation result', () => {
    usePolicyDraftStore.setState({
      simulationResult: {
        totalAffected: 2,
        usersGainingAccess: 0,
        usersLosingAccess: 0,
        usersUnchanged: 2,
        affectedUsers: [],
        riskScore: 0,
        timestamp: new Date().toISOString(),
      },
    });
    usePolicyDraftStore.getState().addNode({
      id: 'c1',
      type: 'condition',
      data: {},
      position: { x: 0, y: 0 },
    });
    expect(usePolicyDraftStore.getState().simulationResult).toBeNull();
  });

  it('markClean resets isDirty and sets lastSavedAt', () => {
    usePolicyDraftStore.setState({ isDirty: true });
    usePolicyDraftStore.getState().markClean();
    const state = usePolicyDraftStore.getState();
    expect(state.isDirty).toBe(false);
    expect(state.lastSavedAt).toBeTruthy();
  });

  it('loadDraft replaces the draft with the saved one and leaves it clean', () => {
    usePolicyDraftStore
      .getState()
      .addNode({ id: 'old', type: 'condition', data: {}, position: { x: 0, y: 0 } });
    usePolicyDraftStore.setState({
      validationErrors: [{ nodeId: 'old', field: 'value', message: 'Value is required' }],
    });

    usePolicyDraftStore.getState().loadDraft(
      [
        {
          id: 'c1',
          type: 'condition',
          data: { field: 'department', operator: 'equals', value: 'Sales' },
          position: { x: 1, y: 2 },
        },
        {
          id: 'a1',
          type: 'action',
          data: { targetSystem: 'entra-id', actionType: 'assign_group' },
          position: { x: 3, y: 4 },
        },
      ],
      [{ id: 'e1', source: 'c1', target: 'a1' }],
    );

    const state = usePolicyDraftStore.getState();
    expect(state.draftNodes.map((n) => n.id)).toEqual(['c1', 'a1']);
    expect(state.draftEdges).toEqual([{ id: 'e1', source: 'c1', target: 'a1' }]);
    expect(state.isDirty).toBe(false);
    expect(state.validationErrors).toEqual([]);
  });

  it('reset clears all state', () => {
    usePolicyDraftStore.getState().addNode({
      id: 'c1',
      type: 'condition',
      data: {},
      position: { x: 0, y: 0 },
    });
    usePolicyDraftStore.getState().addEdge({ id: 'e1', source: 'c1', target: 'a1' });
    usePolicyDraftStore.getState().reset();
    const state = usePolicyDraftStore.getState();
    expect(state.draftNodes).toHaveLength(0);
    expect(state.draftEdges).toHaveLength(0);
    expect(state.isDirty).toBe(false);
    expect(state.simulationResult).toBeNull();
    expect(state.validationErrors).toHaveLength(0);
  });
});
