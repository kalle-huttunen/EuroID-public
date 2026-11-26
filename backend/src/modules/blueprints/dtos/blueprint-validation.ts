import { z } from 'zod';
import { StandardUserSchema } from '@shared/dtos/standard-user.dto';
import { EDGE_CONDITION_OPERATORS } from '../edge-condition-evaluator';
import {
  CORRELATION_SECRET_VAR,
  MIN_CORRELATION_SECRET_LENGTH,
  correlationSecret,
} from '@infrastructure/services/correlation-hash.service';

// ── PATCH /:id — Update node config ─────────────────────────────────

const BoundedConfigValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const UpdateNodeConfigSchema = z.object({
  nodeId: z.string().min(1).optional(),
  nodeType: z.string().optional(),
  config: z.record(z.string().max(100), BoundedConfigValue).optional(),
  policies: z
    .array(z.record(z.string().max(100), BoundedConfigValue))
    .max(50)
    .optional(),
});

export type UpdateNodeConfigDto = z.infer<typeof UpdateNodeConfigSchema>;

// ── POST /save — Save canvas ────────────────────────────────────────

const ViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});

/** Inline CSS of a node or edge (React Flow `style`): sizes, colors, layout keywords. */
const CanvasStyleSchema = z
  .record(z.string().max(100), z.union([z.string().max(200), z.number()]))
  .refine((style) => Object.keys(style).length <= 50, { message: 'At most 50 style properties' });

const CanvasNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.unknown()).optional(),
  style: CanvasStyleSchema.optional(),
});

/**
 * Flow conditions on a Brain -> target edge (EdgeFlowData, edge-condition-evaluator.ts): which
 * users provisioning sends to that target. Set in the Design studio's EdgeConditionPopover and
 * read by getEdgeConditions (activities/config.activities.ts).
 */
const EdgeConditionSchema = z.object({
  id: z.string().min(1).max(100),
  field: z.string().min(1).max(100),
  operator: z.enum(EDGE_CONDITION_OPERATORS),
  value: z.union([z.string().max(500), z.array(z.string().max(500)).max(100)]),
});

const EdgeFlowDataSchema = z.object({
  label: z.string().max(200).optional(),
  conditionsEnabled: z.boolean().optional(),
  conditionGroups: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        join: z.enum(['AND', 'OR']),
        conditions: z.array(EdgeConditionSchema).max(50),
      }),
    )
    .max(20)
    .optional(),
});

/** A React Flow edge as the Design studio keeps it; UI state (`selected`) is not stored. */
const CanvasEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().max(100).nullish(),
  targetHandle: z.string().max(100).nullish(),
  type: z.string().max(100).optional(),
  label: z.string().max(200).optional(),
  animated: z.boolean().optional(),
  style: CanvasStyleSchema.optional(),
  data: EdgeFlowDataSchema.optional(),
});

/**
 * The Brain's identity correlation settings, connectorConfigs['euroid-core'].correlationConfig:
 * CorrelationConfig (shared/types/correlation-config.ts) as the Design studio's Identity
 * Correlation tab saves it, plus the tab's own targetWriteback. The correlation engine,
 * candidate suggestions and HR writeback read it.
 */
const CorrelationRuleSchema = z.object({
  strategy: z.enum(['employeeNumber', 'email', 'hashedNationalId', 'composite', 'heuristicName']),
  compositeFields: z.array(z.string().min(1).max(100)).max(20).optional(),
  nationalIdSourceField: z.string().max(100).optional(),
  nameMatchThreshold: z.number().min(0).max(1).optional(),
  nameMatchMode: z.enum(['exact', 'fuzzy', 'both']).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
});

/**
 * A Hashed National ID rule only while the server can hash: without CORRELATION_HMAC_SECRET
 * ingest drops national IDs unhashed (CorrelationHashService), so the save is refused and says so.
 */
const NATIONAL_ID_NEEDS_SECRET =
  `Hashed National ID needs ${CORRELATION_SECRET_VAR} (at least ` +
  `${MIN_CORRELATION_SECRET_LENGTH} characters) on the server. Without it national IDs are ` +
  'dropped without being hashed and the rule never matches. Ask your operator to set it, or ' +
  'remove the rule.';

const CorrelationRulesSchema = z
  .array(CorrelationRuleSchema)
  .max(20, 'At most 20 correlation rules')
  .superRefine((rules, ctx) => {
    if (correlationSecret()) return;
    rules.forEach((rule, i) => {
      if (rule.strategy !== 'hashedNationalId') return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'strategy'],
        message: NATIONAL_ID_NEEDS_SECRET,
      });
    });
  });

export const CorrelationConfigSchema = z.object({
  rules: CorrelationRulesSchema,
  // Optional like the readers' defaults ('review'), so a stored config saved back as loaded passes.
  conflictAction: z.enum(['auto-link', 'review']).optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  /** Field -> source priority (connector ids), e.g. { email: ['entra-id'] }. */
  fieldMasteryOverrides: z
    .record(z.string().max(100), z.array(z.string().min(1).max(100)).max(20))
    .optional(),
  hrWriteback: z.boolean().optional(),
  targetWriteback: z.boolean().optional(),
});

/** One connector's config object (secrets come back masked from GET and are kept on save). */
const ConnectorConfigEntrySchema = z.record(z.string().max(100), z.unknown());

/**
 * connectorConfigs: connector id -> that connector's config object. The Brain's entry
 * ('euroid-core') carries the correlation settings, validated in full.
 */
const ConnectorConfigsSchema = z
  .object({
    'euroid-core': z
      .object({ correlationConfig: CorrelationConfigSchema.optional() })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(ConnectorConfigEntrySchema)
  .refine((configs) => Object.keys(configs).every((key) => key.length <= 100), {
    message: 'Connector ids are at most 100 characters',
  });

export const SaveCanvasSchema = z.object({
  nodes: z.array(CanvasNodeSchema).max(200, 'Canvas cannot exceed 200 nodes'),
  edges: z.array(CanvasEdgeSchema).max(500, 'Canvas cannot exceed 500 edges'),
  viewport: ViewportSchema.optional(),
  connectorConfigs: ConnectorConfigsSchema.optional(),
  /**
   * The canvas `revision` GET /blueprints/latest returned: a save of a revision that is no longer
   * the stored one is refused with 409. Optional for clients from before revisions (their save is
   * unchecked); required from the next release.
   */
  revision: z.number().int().min(0).optional(),
});

export type SaveCanvasDto = z.infer<typeof SaveCanvasSchema>;

// ── POST /impact-analysis ───────────────────────────────────────────

export const ImpactAnalysisBodySchema = z.object({
  // Simulation users carry no tenantId: the analysis runs in the caller's tenant.
  users: z
    .array(StandardUserSchema.omit({ tenantId: true }).partial())
    .min(1)
    .max(1000)
    .optional(),
  connectors: z.array(z.string().min(1)).max(50).optional(),
  dryRun: z.boolean().optional().default(true),
});

export type ImpactAnalysisDto = z.infer<typeof ImpactAnalysisBodySchema>;

// ── PATCH /pipeline-config ──────────────────────────────────────────

export const PipelineConfigSchema = z.object({
  errorThresholdPercent: z.number().min(1).max(100).optional(),
  minSampleSizeForCircuitBreaker: z.number().int().min(1).max(1000).optional(),
});

export type PipelineConfigDto = z.infer<typeof PipelineConfigSchema>;

/**
 * POST /blueprints/deploy body (optional). `acknowledgeCriticalRisk`: the deployer confirms a
 * critical-risk impact analysis, which Deploy needs then (PipelineService.deploy).
 */
export const DeployBodySchema = z
  .object({ acknowledgeCriticalRisk: z.boolean().optional() })
  .strict();
