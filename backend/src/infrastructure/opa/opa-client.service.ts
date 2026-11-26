/**
 * OPA Client Service — HTTP Client for Open Policy Agent
 *
 * Communicates with OPA server via its REST API (v1/data/).
 * Fail-open: returns null when OPA is unavailable, allowing TypeScript fallback.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OpaQueryInput {
  user: Record<string, unknown>;
  policies: Array<Record<string, unknown>>;
  tenantId: string;
}

export interface OpaQueryResult {
  operations: Array<{
    type: string;
    action: string;
    target: string;
    targetId: string;
    params?: Record<string, unknown>;
    sourcePolicy: string;
    timeConstraint?: { durationDays?: number; expiresAt?: string };
  }>;
}

@Injectable()
export class OpaClientService implements OnModuleInit {
  private readonly logger = new Logger(OpaClientService.name);

  private readonly opaUrl: string;
  private readonly policyPath: string;
  private readonly requestTimeoutMs: number;
  private readonly enabled: boolean;
  private readonly fallbackOnError: boolean;
  private available = false;

  constructor(private readonly configService: ConfigService) {
    this.opaUrl = this.configService.get<string>('opa.OPA_URL') ?? 'http://localhost:8181';
    this.policyPath =
      this.configService.get<string>('opa.OPA_POLICY_PATH') ?? 'euroid/policy/evaluate';
    this.requestTimeoutMs = this.configService.get<number>('opa.OPA_REQUEST_TIMEOUT_MS') ?? 5000;
    this.enabled = this.configService.get<boolean>('opa.OPA_ENABLED') ?? false;
    this.fallbackOnError = this.configService.get<boolean>('opa.OPA_FALLBACK_ON_ERROR') ?? true;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'OPA evaluation disabled (OPA_ENABLED=false). Using TypeScript policy engine.',
      );
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const response = await fetch(`${this.opaUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        this.available = true;
        this.logger.log(`Connected to OPA at ${this.opaUrl}`);
      } else {
        this.logger.warn(
          `OPA health check failed (status ${response.status}). Will use TypeScript fallback.`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `OPA unavailable at ${this.opaUrl}: ${message}. Will use TypeScript fallback.`,
      );
    }
  }

  /** Whether OPA is enabled and reachable. */
  isAvailable(): boolean {
    return this.enabled && this.available;
  }

  /** Whether fallback to TypeScript is allowed on OPA errors. */
  shouldFallback(): boolean {
    return this.fallbackOnError;
  }

  /**
   * Query OPA for policy evaluation.
   * Returns null if OPA is disabled or unavailable. A failed query (an HTTP error, a result without
   * `operations`, a network error or timeout) returns null with OPA_FALLBACK_ON_ERROR=true and
   * throws with false.
   */
  async query(input: OpaQueryInput): Promise<OpaQueryResult | null> {
    if (!this.enabled || !this.available) return null;

    const url = `${this.opaUrl}/v1/data/${this.policyPath}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Thrown to the catch below, which returns null or throws per OPA_FALLBACK_ON_ERROR
      if (!response.ok) throw new Error(`OPA query failed with status ${response.status}`);

      const body = await response.json();
      const result = body.result;

      if (!result || !Array.isArray(result.operations)) {
        throw new Error('OPA returned unexpected result shape');
      }

      return result as OpaQueryResult;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OPA query error: ${message}`);

      if (!this.fallbackOnError) {
        throw new Error(`OPA evaluation failed: ${message}`);
      }
      return null;
    }
  }

  /**
   * Push a policy bundle (compiled Rego) to OPA.
   * Uses OPA's Policy API (PUT /v1/policies/).
   */
  async pushPolicy(policyId: string, regoSource: string): Promise<boolean> {
    if (!this.enabled || !this.available) return false;

    const url = `${this.opaUrl}/v1/policies/${policyId}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: regoSource,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text();
        this.logger.warn(`Failed to push policy ${policyId}: ${response.status} — ${body}`);
        return false;
      }

      this.logger.debug(`Pushed Rego policy: ${policyId}`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to push policy ${policyId}: ${message}`);
      return false;
    }
  }

  /**
   * Push data to OPA's Data API (for user attributes, tenant config).
   */
  async pushData(path: string, data: unknown): Promise<boolean> {
    if (!this.enabled || !this.available) return false;

    const url = `${this.opaUrl}/v1/data/${path}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.warn(`Failed to push data to ${path}: ${response.status}`);
        return false;
      }

      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to push data to ${path}: ${message}`);
      return false;
    }
  }
}
