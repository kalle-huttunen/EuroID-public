/**
 * IConnector — Unified contract for all connector implementations.
 *
 * Connectors must implement the core methods: create, discover (optional), healthCheck.
 * Idempotency: create() called twice with same input returns success (existing resource).
 *
 * @see docs/architecture/IMPROVEMENT_PLAN.md §1.5
 * @see docs/tasks/CURRENT_TASK_23.md
 */
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { ConnectorCapability } from './plugin/connector-manifest.interface';

/** Minimal connector contract for contract tests */
export interface IConnector {
  /**
   * Create or update a user (provision). Must be idempotent:
   * calling twice with same input returns success (existing resource).
   */
  create(user: StandardUserDto, intent?: unknown): Promise<{ targetUserId: string } | string>;

  /**
   * Discover available entitlements (groups, licenses). Optional for connectors
   * that don't support discovery (e.g. AD, Jira).
   */
  discover?(config?: unknown): Promise<Array<{ nativeId: string; name: string; type: string }>>;

  /**
   * Health check — verify connectivity to target system.
   */
  healthCheck(config?: unknown): Promise<boolean>;

  /**
   * Validate which declared capabilities actually work given current permissions.
   * Returns the subset of manifest.capabilities that the connector can perform.
   * On error or timeout, callers should fall back to static manifest.capabilities.
   */
  validateCapabilities?(config?: unknown): Promise<ConnectorCapability[]>;
}

// ── TASK 107 RECAP ──
// Added: Optional validateCapabilities() — returns runtime-validated capability subset given current permissions.
