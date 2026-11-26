/**
 * Node type registry and default styles for the Identity Entitlement Map.
 */

import { IdentityNode } from './IdentityNode';
import { TargetSystemNode } from './TargetSystemNode';
import { EntitlementChip } from './EntitlementChip';
import { AdminAccountNode } from './AdminAccountNode';
import { BRAND } from '@theme/themeConfig';
import type { Edge } from '@xyflow/react';

export const nodeTypes = {
  identityNode: IdentityNode,
  targetSystemNode: TargetSystemNode,
  entitlementChip: EntitlementChip,
  adminAccountNode: AdminAccountNode,
};

export const defaultEdgeOptions: Partial<Edge> = {
  style: { stroke: BRAND.edgeStroke, strokeWidth: 1.5 },
};

export const dashedEdgeStyle = {
  stroke: BRAND.edgeStroke,
  strokeWidth: 1.5,
  strokeDasharray: '5 5',
};

export const policyIntendedEdgeStyle = {
  stroke: BRAND.primary,
  strokeWidth: 1.5,
  strokeDasharray: '5 5',
  opacity: 0.6,
};
