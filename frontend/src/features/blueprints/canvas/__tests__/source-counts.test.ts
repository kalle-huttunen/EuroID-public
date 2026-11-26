import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import { countUsersPerSource } from '../source-counts';

const node = (id: string, data: Record<string, unknown>): Node => ({ id, position: { x: 0, y: 0 }, data });

const csv = node('csv-hr-source', { role: 'source', type: 'csv-hr' });
const json = node('json-api-hr-source', { role: 'source', type: 'json-api-hr' });
const brain = node('euroid-core', { role: 'brain' });
const target = node('entra-target', { role: 'target' });

const users = [
  ...Array.from({ length: 22 }, () => ({ sourceSystem: 'csv-hr' })),
  ...Array.from({ length: 3 }, () => ({ sourceSystem: 'json-api-hr' })),
  { sourceSystem: 'Personio' },
];

describe('countUsersPerSource', () => {
  it('gives each source node its own users, not the hub total', () => {
    expect(countUsersPerSource([csv, json, brain, target], users)).toEqual({
      'csv-hr-source': 22,
      'json-api-hr-source': 3,
    });
  });

  it('matches a configured Source System Name over the connector id', () => {
    const personio = node('csv-hr-source-2', {
      role: 'source',
      type: 'csv-hr',
      config: { sourceSystem: 'Personio' },
    });
    expect(countUsersPerSource([personio], users)).toEqual({ 'csv-hr-source-2': 1 });
  });

  it('falls back to the registry id pattern for nodes saved without a type', () => {
    expect(countUsersPerSource([node('json-api-hr-source-17', { role: 'source' })], users)).toEqual({
      'json-api-hr-source-17': 3,
    });
  });

  it('leaves out a source whose system cannot be told', () => {
    expect(countUsersPerSource([node('mystery', { role: 'source' })], users)).toEqual({});
  });

  it('gives no counts when the user list is only a page of the hub', () => {
    expect(countUsersPerSource([csv, json], users, 1200)).toEqual({});
  });
});
