/**
 * Task Queue Configuration — Bulkhead Pattern
 *
 * Maps connector types to dedicated Temporal task queues so that a slow or failing
 * connector (e.g., Entra ID rate-limited) cannot starve other connectors (AD, Okta, SCIM).
 * Enables per-connector scaling and fault isolation.
 *
 * @see docs/architecture/IMPROVEMENT_PLAN.md §1.2
 * @see docs/tasks/CURRENT_TASK_20.md
 */

import { normalizeSystemName } from '../../shared/utils/normalize-system-name';

/** Queue name prefix for provisioning connectors */
export const PROVISIONING_QUEUE_PREFIX = 'provisioning';

/** Task queue for generic/fallback workflows and non-connector activities */
export const DEFAULT_PROVISIONING_QUEUE = `${PROVISIONING_QUEUE_PREFIX}-default`;

/** Connector types with dedicated queues */
export const CONNECTOR_QUEUES = ['entra', 'ad', 'scim', 'okta'] as const;

/** Mapping: connector type → queue name */
export const QUEUE_NAMES: Record<string, string> = {
  default: DEFAULT_PROVISIONING_QUEUE,
  entra: `${PROVISIONING_QUEUE_PREFIX}-entra`,
  'entra-id': `${PROVISIONING_QUEUE_PREFIX}-entra`,
  ad: `${PROVISIONING_QUEUE_PREFIX}-ad`,
  'active-directory': `${PROVISIONING_QUEUE_PREFIX}-ad`,
  scim: `${PROVISIONING_QUEUE_PREFIX}-scim`,
  okta: `${PROVISIONING_QUEUE_PREFIX}-okta`,
};

/**
 * Register a new connector queue at runtime (called by PluginRegistryService or plugin bootstrap).
 */
export function registerConnectorQueue(connectorId: string, queueName: string): void {
  QUEUE_NAMES[connectorId] = queueName;
}

/**
 * Normalize connector type for queue lookup (e.g., 'entra-id' → 'entra').
 */
export function normalizeConnectorType(connectorType: string): string {
  if (!connectorType || typeof connectorType !== 'string') return 'default';
  const normalized = normalizeSystemName(connectorType);
  return normalized || 'default';
}

/**
 * Get the task queue for a connector type.
 * Used by workflows when routing activities to connector-specific queues.
 *
 * @param connectorType - connector identifier (e.g., 'entra', 'entra-id', 'ad', 'okta')
 * @returns queue name (e.g., 'provisioning-entra' or 'provisioning-default' for unknown)
 */
export function getTaskQueueForConnector(connectorType: string): string {
  if (!connectorType) return DEFAULT_PROVISIONING_QUEUE;
  const normalized = normalizeSystemName(connectorType);
  if (!normalized) return DEFAULT_PROVISIONING_QUEUE;

  // Direct lookup (preserves aliases like 'entra-id' → provisioning-entra)
  const directKey = connectorType.toLowerCase().trim();
  if (QUEUE_NAMES[directKey]) return QUEUE_NAMES[directKey];

  // Normalized lookup (entra-id → entraid → entra match)
  return QUEUE_NAMES[normalized] ?? DEFAULT_PROVISIONING_QUEUE;
}

/** All provisioning queue names (for worker registration) */
export const ALL_PROVISIONING_QUEUES: string[] = [
  DEFAULT_PROVISIONING_QUEUE,
  ...CONNECTOR_QUEUES.map((c) => QUEUE_NAMES[c]),
];
