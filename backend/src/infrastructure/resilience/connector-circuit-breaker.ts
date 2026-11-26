/**
 * Connector Circuit Breaker
 *
 * Circuit breakers (cockatiel) around the calls of connectors to their target systems (Entra ID,
 * SCIM), to fail fast while a target is down. One breaker per tenant, connector and target (the
 * caller names the target: the Entra ID directory and app, the SCIM base URL), so a target
 * that fails for one tenant never blocks another tenant or another target. Only a failure of the
 * target counts (isTargetFailure): a 5xx answer or no answer at all. A 4xx, a 429 or a refused
 * sign-in is the target answering, and is never counted.
 * Emits domain events and Prometheus metrics (labelled by connector) on state changes.
 */

import { HttpException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConsecutiveBreaker, circuitBreaker, handleWhen, CircuitState } from 'cockatiel';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { DomainEventEmitterService } from '../events/event-emitter.service';
import { DomainEventType } from '../events/event-types';
import { MetricsService } from '../observability/metrics.service';
import { requestContext } from '../middleware/correlation.middleware';

const HALF_OPEN_AFTER_MS = 30_000;
const CONSECUTIVE_FAILURES = 5;

const STATE_LABELS: Record<CircuitState, string> = {
  [CircuitState.Closed]: 'closed',
  [CircuitState.Open]: 'open',
  [CircuitState.HalfOpen]: 'half-open',
  [CircuitState.Isolated]: 'isolated',
};

function stateToGaugeValue(state: CircuitState): number {
  switch (state) {
    case CircuitState.Closed:
      return 0;
    case CircuitState.Open:
      return 1;
    case CircuitState.HalfOpen:
      return 2;
    case CircuitState.Isolated:
      return 3;
    default:
      return 0;
  }
}

/**
 * Whether an error means the target failed: no answer (network error, timeout), or an answer
 * of 500 or more, as an axios error or as the exception a connector made of it (a 502
 * ConnectorException). A 4xx, a rate limit (429) and any other HTTP exception below 500 are the
 * target answering; an error of no HTTP kind (a socket or DNS error) counts.
 */
export function isTargetFailure(error: unknown): boolean {
  if (error instanceof RateLimitedException) return false;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === undefined || status >= 500;
  }
  if (error instanceof HttpException) return error.getStatus() >= 500;
  return true;
}

interface CircuitBreakerPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  onStateChange(cb: (state: CircuitState) => void): { dispose: () => void };
}

@Injectable()
export class ConnectorCircuitBreakerService {
  private readonly logger = new Logger(ConnectorCircuitBreakerService.name);
  private readonly breakers = new Map<string, CircuitBreakerPolicy>();

  constructor(
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly metrics: MetricsService,
  ) {}

  private getOrCreateBreaker(connector: string, key: string): CircuitBreakerPolicy {
    let policy = this.breakers.get(key);
    if (!policy) {
      const breaker = new ConsecutiveBreaker(CONSECUTIVE_FAILURES);
      const circuitPolicy = circuitBreaker(handleWhen(isTargetFailure), {
        halfOpenAfter: HALF_OPEN_AFTER_MS,
        breaker,
      }) as CircuitBreakerPolicy;

      circuitPolicy.onStateChange((state) => {
        const label = STATE_LABELS[state] ?? 'unknown';
        this.metrics.circuitBreakerTripsTotal.inc({
          connector,
          state: label,
        });
        this.metrics.circuitBreakerState.set({ connector, state: label }, stateToGaugeValue(state));
        this.eventEmitter.emit(DomainEventType.CONNECTOR_CIRCUIT_BREAKER_TRIPPED, connector, {
          connector,
          state: label,
        });
        this.logger.warn(`[CircuitBreaker] ${key} state changed to ${label}`);
      });

      this.breakers.set(key, circuitPolicy);
      policy = circuitPolicy;
    }
    return policy;
  }

  /**
   * Execute a function with circuit breaker protection: the breaker of the current tenant (the
   * request or activity context), `connector` and `target` (what the call reaches, never a
   * secret). Throws BrokenCircuitError while that breaker is open; otherwise executes and
   * propagates the result or error.
   */
  async execute<T>(connector: string, fn: () => Promise<T>, target = ''): Promise<T> {
    const tenantId = requestContext.getStore()?.tenantId ?? '';
    const policy = this.getOrCreateBreaker(connector, `${connector}|${tenantId}|${target}`);
    return policy.execute(fn);
  }
}
