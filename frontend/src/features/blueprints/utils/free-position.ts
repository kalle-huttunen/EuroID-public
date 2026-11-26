/**
 * Where a node added to the Design studio canvas goes. Click-to-add aims at the center of the
 * visible canvas, which is where the Brain node sits; a node placed there covered the Brain.
 */
import type { Node } from '@xyflow/react';

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  x: number;
  y: number;
}

/** Size assumed for a node React Flow has not measured yet (a policy node about to be added). */
export const DEFAULT_NODE_SIZE: Size = { width: 180, height: 60 };

/** Space kept between an added node and the nodes around it. */
export const NODE_GAP = 16;

const near = (a: Box, b: Box) =>
  a.x < b.x + b.width + NODE_GAP &&
  b.x < a.x + a.width + NODE_GAP &&
  a.y < b.y + b.height + NODE_GAP &&
  b.y < a.y + a.height + NODE_GAP;

/**
 * `start` when a node of `size` there keeps clear of every occupied box, else the first position
 * straight below the boxes it would cover. Repeated adds at one point form a column.
 */
export function freePosition(
  start: { x: number; y: number },
  size: Size,
  occupied: Box[],
): { x: number; y: number } {
  let position = { ...start };
  for (;;) {
    const hits = occupied.filter((box) => near({ ...position, ...size }, box));
    if (hits.length === 0) return position;
    position = { x: position.x, y: Math.max(...hits.map((b) => b.y + b.height)) + NODE_GAP };
  }
}

const pixels = (value: unknown) => (typeof value === 'number' ? value : undefined);

type PlacedNode = Pick<Node, 'position'> &
  Partial<Pick<Node, 'measured' | 'width' | 'height' | 'style'>>;

/** The box a canvas node covers: its measured size, else its styled size, else the default. */
export function nodeBox(node: PlacedNode, measured?: Partial<Size>): Box {
  return {
    x: node.position.x,
    y: node.position.y,
    width:
      measured?.width ??
      node.measured?.width ??
      node.width ??
      pixels(node.style?.width) ??
      DEFAULT_NODE_SIZE.width,
    height:
      measured?.height ??
      node.measured?.height ??
      node.height ??
      pixels(node.style?.height) ??
      DEFAULT_NODE_SIZE.height,
  };
}
