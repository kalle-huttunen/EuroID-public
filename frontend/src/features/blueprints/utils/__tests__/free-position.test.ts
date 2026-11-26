/**
 * Click-to-add puts a policy node at the center of the visible canvas, where the Brain node sits;
 * the new node used to land on top of it (plan 2.0co). freePosition moves it clear.
 */
import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import { DEFAULT_NODE_SIZE, NODE_GAP, freePosition, nodeBox, type Box } from '../free-position';

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const brain: Box = { x: 350, y: 250, width: 190, height: 60 };

describe('freePosition', () => {
  it('keeps the point when nothing is near it', () => {
    expect(freePosition({ x: 0, y: 0 }, DEFAULT_NODE_SIZE, [brain])).toEqual({ x: 0, y: 0 });
  });

  it('moves a node aimed at the Brain straight below it, clear of it', () => {
    const position = freePosition({ x: 445, y: 280 }, DEFAULT_NODE_SIZE, [brain]);

    expect(position).toEqual({ x: 445, y: brain.y + brain.height + NODE_GAP });
    expect(overlaps({ ...position, ...DEFAULT_NODE_SIZE }, brain)).toBe(false);
  });

  it('stacks repeated adds at one point into a column, none covering another', () => {
    const placed: Box[] = [brain];
    for (let i = 0; i < 4; i++) {
      const position = freePosition({ x: 445, y: 280 }, DEFAULT_NODE_SIZE, placed);
      for (const box of placed) {
        expect(overlaps({ ...position, ...DEFAULT_NODE_SIZE }, box)).toBe(false);
      }
      placed.push({ ...position, ...DEFAULT_NODE_SIZE });
    }
    expect(new Set(placed.slice(1).map((b) => b.x))).toEqual(new Set([445]));
  });

  it('also keeps a gap from a node it would only touch', () => {
    const position = freePosition(
      { x: brain.x, y: brain.y + brain.height + 1 },
      DEFAULT_NODE_SIZE,
      [brain],
    );
    expect(position.y).toBe(brain.y + brain.height + NODE_GAP);
  });
});

describe('nodeBox', () => {
  const node = (extra: Partial<Node>): Node =>
    ({ id: 'n', position: { x: 10, y: 20 }, data: {}, ...extra }) as Node;

  it('uses the measured size first, then the styled size, then the default', () => {
    expect(nodeBox(node({ measured: { width: 200, height: 50 } }))).toEqual({
      x: 10,
      y: 20,
      width: 200,
      height: 50,
    });
    expect(nodeBox(node({ style: { width: 190, height: 60 } }))).toMatchObject({
      width: 190,
      height: 60,
    });
    expect(nodeBox(node({}))).toMatchObject(DEFAULT_NODE_SIZE);
    expect(nodeBox(node({}), { width: 140, height: 44 })).toMatchObject({ width: 140, height: 44 });
  });
});
