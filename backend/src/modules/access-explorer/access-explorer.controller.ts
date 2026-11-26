/**
 * Access Explorer Controller
 *
 * REST API for querying the identity access graph (Neo4j):
 *   GET  /api/v1/access-explorer/identity/:id/graph          full access graph (viewer)
 *   GET  /api/v1/access-explorer/entitlement/:id/holders     who has this entitlement (viewer)
 *   GET  /api/v1/access-explorer/path                        shortest path query (viewer)
 *   GET  /api/v1/access-explorer/identity/:id/sod-violations transitive SoD check (viewer)
 *   POST /api/v1/access-explorer/resync                      load the graph from MongoDB (super-admin)
 *
 * Every route answers 503 with what to do when Neo4j is not configured, not connected or a query
 * fails (GraphService.readStrict / writeStrict), never empty data. :id is the identity's `_id`
 * or the entitlement's graph key `<system>::<native id>` (entitlement-node-id.ts), the keys of
 * the graph's nodes; a bare native id answers 400, since it can name entitlements in two systems.
 */
import { Controller, Get, Post, HttpCode, Param, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  AccessExplorerService,
  HOLDER_PATH_LIMIT,
  IDENTITY_GRAPH_PATH_LIMIT,
} from './access-explorer.service';
import { GraphResyncService } from './graph-resync.service';
import { EntitlementNodeIdSchema } from './entitlement-node-id';
import { z, ZodError } from 'zod';

const GRAPH_UNAVAILABLE_RESPONSE = {
  status: 503,
  description:
    'The access graph is not available: Neo4j is not configured (NEO4J_PASSWORD empty), the ' +
    'API is not connected to it (it connects on its own once Neo4j answers), or the query ' +
    'failed. The message says which and what to do. No empty answer stands for a missing graph.',
};

/**
 * Group nesting is not modelled: no group-in-group membership is written to the graph (a SCIM
 * inbound group records a member that is a group, which nothing reads into it).
 */
const NO_NESTING =
  'The graph holds no group nesting, so nothing writes MEMBER_OF: every path is one HAS_ACCESS step.';

// ── Zod Schemas ─────────────────────────────────────────────────────

const PathQuerySchema = z.object({
  fromIdentity: z.string().min(1, 'fromIdentity is required').max(200),
  toEntitlement: z.string().min(1, 'toEntitlement is required').pipe(EntitlementNodeIdSchema),
});

// ── Controller ──────────────────────────────────────────────────────

@ApiTags('Access Explorer')
@ApiBearerAuth('jwt')
@Controller('access-explorer')
export class AccessExplorerController {
  constructor(
    private readonly accessExplorerService: AccessExplorerService,
    private readonly graphResyncService: GraphResyncService,
  ) {}

  @Get('identity/:id/graph')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Access graph of an identity',
    description:
      `The identity's node and every path from it over HAS_ACCESS and MEMBER_OF (up to 5 hops), ` +
      `at most ${IDENTITY_GRAPH_PATH_LIMIT} paths (truncated: true when the graph has more). ` +
      'Relationships point at node ids. identityFound: false when the graph has no node for ' +
      `the identity (not loaded yet), which is not the same as no access. ${NO_NESTING}`,
  })
  @ApiResponse({ status: 200, description: 'The graph, identityFound and truncated.' })
  @ApiResponse(GRAPH_UNAVAILABLE_RESPONSE)
  async getIdentityGraph(@Param('id') id: string) {
    const tenantId = getCurrentTenantId();
    const result = await this.accessExplorerService.getIdentityAccessGraph(id, tenantId);
    return {
      identityId: id,
      identityFound: result.identityFound,
      nodes: result.nodes,
      relationships: result.relationships,
      nodeCount: result.nodes.length,
      relationshipCount: result.relationships.length,
      truncated: result.truncated,
      pathLimit: IDENTITY_GRAPH_PATH_LIMIT,
    };
  }

  @Get('entitlement/:id/holders')
  @Roles('viewer')
  @ApiOperation({
    summary: 'All identities that have access to this entitlement',
    description:
      ":id is the entitlement's graph key, <system>::<native id> (e.g. entra-id::<group object " +
      'id>), as the graph answers it. One holder per path (an identity reaching it two ways is ' +
      `listed twice), at most ${HOLDER_PATH_LIMIT} paths (truncated: true when the graph has ` +
      'more). entitlementFound: false when the graph has no node for the entitlement.',
  })
  @ApiResponse({ status: 200, description: 'The holders, entitlementFound and truncated.' })
  @ApiResponse({ status: 400, description: ':id is not <system>::<native id>.' })
  @ApiResponse(GRAPH_UNAVAILABLE_RESPONSE)
  async getEntitlementHolders(@Param('id') rawId: string) {
    const id = EntitlementNodeIdSchema.parse(rawId);
    const tenantId = getCurrentTenantId();
    const result = await this.accessExplorerService.getEntitlementHolders(id, tenantId);
    return {
      entitlementId: id,
      entitlementFound: result.entitlement !== null,
      entitlement: result.entitlement,
      holders: result.holders.map((h) => ({
        identity: h.identity,
        pathDepth: h.path.depth,
        pathNodes: h.path.nodes,
        pathRelationships: h.path.relationships,
      })),
      count: result.holders.length,
      truncated: result.truncated,
      pathLimit: HOLDER_PATH_LIMIT,
    };
  }

  @Get('path')
  @Roles('viewer')
  @ApiOperation({
    summary: 'Shortest access path between identity and entitlement',
    description:
      "toEntitlement is the entitlement's graph key, <system>::<native id>. found: false with " +
      'identityFound and entitlementFound saying whether each end is in the graph.',
  })
  @ApiResponse({ status: 200, description: 'The path or found: false, and the ends found.' })
  @ApiResponse({
    status: 400,
    description:
      'fromIdentity or toEntitlement missing or too long, or toEntitlement not <system>::<native id>.',
  })
  @ApiResponse(GRAPH_UNAVAILABLE_RESPONSE)
  @ApiQuery({ name: 'fromIdentity', required: true, type: String })
  @ApiQuery({ name: 'toEntitlement', required: true, type: String })
  async findAccessPath(
    @Query('fromIdentity') fromIdentity?: string,
    @Query('toEntitlement') toEntitlement?: string,
  ) {
    let parsed: z.infer<typeof PathQuerySchema>;
    try {
      parsed = PathQuerySchema.parse({ fromIdentity, toEntitlement });
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException(
          `Validation failed: ${error.errors.map((e) => e.message).join(', ')}`,
        );
      }
      throw error;
    }

    const tenantId = getCurrentTenantId();
    const { identityFound, entitlementFound, path } =
      await this.accessExplorerService.findAccessPath(
        parsed.fromIdentity,
        parsed.toEntitlement,
        tenantId,
      );

    return {
      fromIdentity: parsed.fromIdentity,
      toEntitlement: parsed.toEntitlement,
      identityFound,
      entitlementFound,
      found: path !== null,
      path: path
        ? {
            nodes: path.nodes,
            relationships: path.relationships,
            depth: path.depth,
          }
        : null,
    };
  }

  @Get('identity/:id/sod-violations')
  @Roles('viewer')
  @ApiOperation({
    summary: 'SoD violations of the access an identity has in the graph',
    description:
      "The tenant's active SoD policies whose every entitlement the identity reaches in the graph. " +
      'policiesChecked: how many active policies name entitlements; identityFound: false when ' +
      `the graph has no node for the identity (then nothing was checked). ${NO_NESTING}`,
  })
  @ApiResponse({ status: 200, description: 'The violations, identityFound, policiesChecked.' })
  @ApiResponse(GRAPH_UNAVAILABLE_RESPONSE)
  async getSodViolations(@Param('id') id: string) {
    const tenantId = getCurrentTenantId();
    const { identityFound, policiesChecked, violations } =
      await this.accessExplorerService.getTransitiveSodViolations(id, tenantId);
    return {
      identityId: id,
      identityFound,
      policiesChecked,
      violations: violations.map((v) => ({
        policyName: v.policyName,
        severity: v.severity,
        action: v.action,
        entitlementA: v.entitlementA,
        entitlementB: v.entitlementB,
        pathToA: {
          nodes: v.pathToA.nodes,
          relationships: v.pathToA.relationships,
          depth: v.pathToA.depth,
        },
        pathToB: {
          nodes: v.pathToB.nodes,
          relationships: v.pathToB.relationships,
          depth: v.pathToB.depth,
        },
        conflictingEntitlements: v.conflictingEntitlements.map((c) => ({
          entitlement: c.entitlement,
          path: { nodes: c.path.nodes, relationships: c.path.relationships, depth: c.path.depth },
        })),
      })),
      violationCount: violations.length,
    };
  }

  @Post('resync')
  @HttpCode(200)
  @Roles('super-admin')
  @ApiOperation({
    summary: "Load the caller's tenant from MongoDB into the access graph (super-admin)",
    description:
      'Merges every identity, every entitlement catalog entry with a native id and its ' +
      'application, and the access the identity page calls Active (policy grants on a synced ' +
      "account, active access requests' entitlements) as HAS_ACCESS with grantedBy and source; " +
      "then removes the tenant's nodes and edges MongoDB no longer has. Runs synchronously.",
  })
  @ApiResponse({ status: 200, description: 'Counts written and removed, and the duration.' })
  @ApiResponse({ status: 403, description: 'Requires super-admin role' })
  @ApiResponse({ status: 409, description: 'A resync of this tenant is already running.' })
  @ApiResponse(GRAPH_UNAVAILABLE_RESPONSE)
  async resync() {
    return this.graphResyncService.resync(getCurrentTenantId());
  }
}
