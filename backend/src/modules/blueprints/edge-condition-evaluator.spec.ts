import { evaluateEdgeConditions, EdgeFlowData } from './edge-condition-evaluator';

describe('Edge Condition Evaluator', () => {
  const baseUser = {
    departmentName: 'Engineering',
    departmentCode: 'ENG',
    location: 'Helsinki',
    countryCode: 'FI',
    status: 'ACTIVE',
    jobTitle: 'Senior Engineer',
    email: 'john@example.com',
  };

  describe('evaluateEdgeConditions', () => {
    it('should return true when conditions are not enabled', () => {
      const edge: EdgeFlowData = { conditionsEnabled: false };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should return true when no condition groups exist', () => {
      const edge: EdgeFlowData = { conditionsEnabled: true, conditionGroups: [] };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should return true when edgeData is null/undefined', () => {
      expect(evaluateEdgeConditions(baseUser, null as any)).toBe(true);
      expect(evaluateEdgeConditions(baseUser, undefined as any)).toBe(true);
    });

    it('should match equals condition (case-insensitive)', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'engineering' }],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should handle not_equals operator', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'department', operator: 'not_equals', value: 'Sales' }],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should handle contains operator', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'jobTitle', operator: 'contains', value: 'Engineer' }],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should handle "in" operator with array value', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'countryCode', operator: 'in', value: ['FI', 'SE', 'NO'] }],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should AND multiple conditions within a group', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [
            { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            { id: 'c2', field: 'countryCode', operator: 'equals', value: 'FI' },
          ],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should fail AND group when one condition fails', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [
            { id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' },
            { id: 'c2', field: 'countryCode', operator: 'equals', value: 'US' },
          ],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(false);
    });

    it('should OR conditions within a group', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'OR',
          conditions: [
            { id: 'c1', field: 'department', operator: 'equals', value: 'Sales' },
            { id: 'c2', field: 'department', operator: 'equals', value: 'Engineering' },
          ],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should AND between multiple groups (all groups must pass)', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [
          {
            id: 'g1', join: 'AND',
            conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' }],
          },
          {
            id: 'g2', join: 'AND',
            conditions: [{ id: 'c2', field: 'countryCode', operator: 'equals', value: 'US' }],
          },
        ],
      };
      // First group passes, second fails → overall false
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(false);
    });

    it('should handle is_empty for undefined field', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'nonExistentField', operator: 'is_empty', value: '' }],
        }],
      };
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });

    it('should resolve department alias to departmentName', () => {
      const edge: EdgeFlowData = {
        conditionsEnabled: true,
        conditionGroups: [{
          id: 'g1', join: 'AND',
          conditions: [{ id: 'c1', field: 'department', operator: 'equals', value: 'Engineering' }],
        }],
      };
      // User has departmentName='Engineering' — field alias 'department' should resolve
      expect(evaluateEdgeConditions(baseUser, edge)).toBe(true);
    });
  });
});
