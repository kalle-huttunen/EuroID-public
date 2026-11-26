/**
 * useEntitlementGraph — transforms flat aggregated data into ReactFlow nodes[] and edges[].
 *
 * Layout: Identity at center top → target systems in a row below → entitlements grouped
 * under their target → admin accounts to the right of identity.
 *
 * Target systems are the identity's provisioning entries; the entitlements under each are the
 * ones its policies and access requests grant it there (not the system's catalogue).
 */

import { useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type { IdentityEntitlementsData } from './useIdentityEntitlements';
import type { IdentityNodeData } from '../canvas/IdentityNode';
import type { TargetSystemNodeData, SyncStatus } from '../canvas/TargetSystemNode';
import type { EntitlementChipData } from '../canvas/EntitlementChip';
import type { IdentityEntitlement } from '@api/identity-map-api';
import type { AdminAccountNodeData } from '../canvas/AdminAccountNode';
import { dashedEdgeStyle, policyIntendedEdgeStyle } from '../canvas/nodes';

// ── Layout Constants ──────────────────────────────────────────────────

const IDENTITY_Y = 50;
const TARGET_Y = 250;
const ENTITLEMENT_START_Y = 430;
const ENTITLEMENT_GAP_Y = 50;
const ADMIN_Y = 50;
const TARGET_GAP_X = 250;
const ADMIN_OFFSET_X = 350;

export interface EntitlementGraphResult {
  nodes: Node[];
  edges: Edge[];
}

/** Compares system names as the backend does (normalize-system-name.ts): 'entra' = 'entra-id'. */
function systemKey(name: string): string {
  const n = name.toLowerCase().replace(/-/g, '');
  if (n === 'entraid') return 'entra';
  if (n === 'activedirectory') return 'ad';
  return n;
}

/**
 * Whether two names mean the same target system: provisioning records Entra ID as 'entra' where
 * policies, access requests and drifts say 'entra-id'.
 */
export function isSameTargetSystem(a: string, b: string): boolean {
  return systemKey(a) === systemKey(b);
}

const CHIP_TYPES: Record<string, EntitlementChipData['type']> = {
  group: 'Group',
  license: 'License',
  role: 'DirectoryRole',
  directoryrole: 'DirectoryRole',
};

/** Chip of a granted entitlement, with governance level and type from the catalogue. */
function chipData(
  ent: IdentityEntitlement,
  catalogBySystem: IdentityEntitlementsData['catalogBySystem'],
): EntitlementChipData {
  const catalogEntry = catalogBySystem[ent.targetSystem]?.find(
    (c) => c.nativeId === ent.entitlement || c.name === ent.entitlement,
  );
  return {
    name: ent.entitlement,
    type: catalogEntry?.type ?? CHIP_TYPES[ent.type.toLowerCase()] ?? 'Group',
    governanceLevel: catalogEntry?.governanceLevel,
    origin: ent.grantedBy === 'request' ? 'REQUEST' : 'POLICY',
    sourcePolicy: ent.grantedBy === 'policy' ? ent.source : undefined,
    isProvisioned: ent.status === 'Active',
    ...(ent.expiresAt ? { expiresAt: ent.expiresAt } : {}),
  };
}

export function useEntitlementGraph(data: IdentityEntitlementsData): EntitlementGraphResult {
  return useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    if (!data.identity) return { nodes, edges };

    const identity = data.identity;
    const displayName =
      (identity.displayName as string) ||
      `${identity.firstName ?? ''} ${identity.lastName ?? ''}`.trim() ||
      (identity.email as string) ||
      'Unknown';

    // ── Compute layout center based on number of target systems ──
    const targetCount = data.provisioning.length;
    const totalTargetWidth = targetCount > 0 ? (targetCount - 1) * TARGET_GAP_X : 0;
    const centerX = totalTargetWidth / 2 + 100;

    // ── Identity Node ──
    nodes.push({
      id: 'identity',
      type: 'identityNode',
      position: { x: centerX - 110, y: IDENTITY_Y },
      data: {
        displayName,
        email: (identity.email as string) ?? '',
        jobTitle: (identity.jobTitle as string) ?? '',
        status: (identity.status as string) ?? 'UNKNOWN',
        riskScore: data.riskScore?.score ?? null,
      } satisfies IdentityNodeData,
    });

    // ── Drifts per target system ──
    const driftCountOf = (system: string) =>
      data.drifts.filter((d) => isSameTargetSystem(d.targetSystem, system)).length;

    // ── Target System Nodes + Entitlements ──
    data.provisioning.forEach((prov, idx) => {
      if (prov.status === 'DEPROVISIONED') return;

      const system = prov.targetSystem;
      const targetId = `target-${system}`;
      const targetX = idx * TARGET_GAP_X + 100;
      const driftCount = driftCountOf(system);

      // Determine sync status (promote to DRIFT if drifts exist)
      let syncStatus: SyncStatus = prov.status as SyncStatus;
      if (driftCount > 0 && syncStatus === 'SYNCED') {
        syncStatus = 'DRIFT';
      }

      // What the identity holds or is being granted here; a revoked grant is not access.
      const entitlements = data.entitlements.filter(
        (e) => e.status !== 'Revoked' && isSameTargetSystem(e.targetSystem, system),
      );

      nodes.push({
        id: targetId,
        type: 'targetSystemNode',
        position: { x: targetX, y: TARGET_Y },
        data: {
          systemName: system,
          syncStatus,
          entitlementCount: entitlements.length,
          driftCount,
        } satisfies TargetSystemNodeData,
      });

      // Edge: identity → target
      edges.push({
        id: `e-identity-${targetId}`,
        source: 'identity',
        target: targetId,
        sourceHandle: 'to-targets',
        targetHandle: 'from-identity',
      });

      // Entitlement chips under this target
      entitlements.forEach((ent, entIdx) => {
        const entNodeId = `ent-${system}-${entIdx}-${ent.id}`;
        const chip = chipData(ent, data.catalogBySystem);

        nodes.push({
          id: entNodeId,
          type: 'entitlementChip',
          position: {
            x: targetX - 20,
            y: ENTITLEMENT_START_Y + entIdx * ENTITLEMENT_GAP_Y,
          },
          data: chip,
        });

        // Granted but not provisioned yet: dashed, as in the legend
        edges.push({
          id: `e-${targetId}-${entNodeId}`,
          source: targetId,
          target: entNodeId,
          sourceHandle: 'to-entitlements',
          targetHandle: 'from-target',
          style: chip.isProvisioned ? undefined : policyIntendedEdgeStyle,
        });
      });
    });

    // ── Admin Account Nodes ──
    data.adminAccounts.forEach((admin, idx) => {
      const adminNodeId = `admin-${admin.identityId}`;

      nodes.push({
        id: adminNodeId,
        type: 'adminAccountNode',
        position: {
          x: centerX + ADMIN_OFFSET_X,
          y: ADMIN_Y + idx * 120,
        },
        data: {
          identityId: admin.identityId,
          adminTier: admin.adminTier,
          status: admin.status,
          activatedAt: admin.activatedAt,
        } satisfies AdminAccountNodeData,
      });

      edges.push({
        id: `e-identity-${adminNodeId}`,
        source: 'identity',
        target: adminNodeId,
        sourceHandle: 'to-admins',
        targetHandle: 'from-identity',
        style: dashedEdgeStyle,
      });
    });

    return { nodes, edges };
  }, [data]);
}
