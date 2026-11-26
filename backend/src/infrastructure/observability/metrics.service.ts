import { Injectable, Logger } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

const HISTOGRAM_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];

/** Gauges counted in MongoDB when Prometheus scrapes, by the module that owns the data. */
export type ScrapeCountedGauge =
  | 'euroid_access_requests_pending'
  | 'euroid_identities_total'
  | 'euroid_access_review_campaigns_active';

/** A count read at scrape: a number, or a number per value of the gauge's one label. */
export type ScrapeCount = () => Promise<number | Record<string, number>>;

/**
 * Prometheus metrics service for EuroID.
 * Exposes provisioning rates, connector latency, drift frequency, policy evaluation,
 * HTTP request performance, access request/review lifecycle, and identity operations.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly logger = new Logger(MetricsService.name);

  /** The counts of the scrape-counted gauges (countAtScrape). */
  private readonly counts = new Map<ScrapeCountedGauge, ScrapeCount>();

  // ── Provisioning ──────────────────────────────
  readonly provisioningTotal: Counter;
  readonly provisioningDuration: Histogram;

  // ── Drift & Reconciliation ────────────────────
  readonly driftDetected: Counter;
  readonly driftResolved: Counter;

  // ── Policy Engine ─────────────────────────────
  readonly policyEvaluationTotal: Counter;
  readonly policyEvaluationDuration: Histogram;

  // ── Connector API ─────────────────────────────
  readonly connectorApiCallsTotal: Counter;
  readonly connectorApiLatency: Histogram;

  // ── Circuit Breaker ───────────────────────────
  readonly circuitBreakerTripsTotal: Counter;
  readonly circuitBreakerState: Gauge;

  // ── Identity Lifecycle ────────────────────────
  readonly identitiesTotal: Gauge;
  readonly identityOperationsTotal: Counter;

  // ── HTTP Request Performance ──────────────────
  readonly httpRequestDuration: Histogram;
  readonly httpRequestsTotal: Counter;

  // ── Access Requests ───────────────────────────
  readonly accessRequestsTotal: Counter;
  readonly accessRequestsPending: Gauge;

  // ── Access Reviews ────────────────────────────
  readonly accessReviewDecisionsTotal: Counter;
  readonly accessReviewCampaignsActive: Gauge;

  // ── Anomaly Detection ─────────────────────────
  readonly anomaliesDetectedTotal: Counter;

  // ── Mover Workflow ────────────────────────────
  readonly moverOperationsTotal: Counter;
  readonly moverDuration: Histogram;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    // ── Provisioning ──────────────────────────────
    this.provisioningTotal = new Counter({
      name: 'euroid_provisioning_total',
      help: 'Total provisioning operations',
      labelNames: ['connector', 'status', 'tenant'],
      registers: [this.registry],
    });

    this.provisioningDuration = new Histogram({
      name: 'euroid_provisioning_duration_ms',
      help: 'Provisioning duration in milliseconds',
      labelNames: ['connector', 'tenant'],
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    // ── Drift & Reconciliation ────────────────────
    this.driftDetected = new Counter({
      name: 'euroid_drift_detected_total',
      help: 'Total drift detections',
      labelNames: ['system', 'severity', 'tenant'],
      registers: [this.registry],
    });

    this.driftResolved = new Counter({
      name: 'euroid_drift_resolved_total',
      help: 'Total drift resolutions',
      labelNames: ['system', 'tenant'],
      registers: [this.registry],
    });

    // ── Policy Engine ─────────────────────────────
    this.policyEvaluationTotal = new Counter({
      name: 'euroid_policy_evaluation_total',
      help: 'Total policy evaluations',
      registers: [this.registry],
    });

    this.policyEvaluationDuration = new Histogram({
      name: 'euroid_policy_evaluation_duration_ms',
      help: 'Policy evaluation duration in milliseconds',
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    // ── Connector API ─────────────────────────────
    this.connectorApiCallsTotal = new Counter({
      name: 'euroid_connector_api_calls_total',
      help: 'Total connector API calls',
      labelNames: ['connector', 'endpoint', 'status'],
      registers: [this.registry],
    });

    this.connectorApiLatency = new Histogram({
      name: 'euroid_connector_api_latency_ms',
      help: 'Connector API latency in milliseconds',
      labelNames: ['connector'],
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    // ── Circuit Breaker ───────────────────────────
    this.circuitBreakerTripsTotal = new Counter({
      name: 'euroid_circuit_breaker_trips_total',
      help: 'Total connector circuit breaker trips',
      labelNames: ['connector', 'state'],
      registers: [this.registry],
    });

    this.circuitBreakerState = new Gauge({
      name: 'euroid_circuit_breaker_state',
      help: 'Circuit breaker state: 0=closed, 1=open, 2=half-open',
      labelNames: ['connector', 'state'],
      registers: [this.registry],
    });

    // ── Identity Lifecycle ────────────────────────
    // Gauges counted in MongoDB at each scrape (countAtScrape): only this process serves
    // /metrics, while much of what changes them happens in the worker, and a gauge kept by events
    // here would also start from 0 after a restart.
    this.identitiesTotal = new Gauge({
      name: 'euroid_identities_total',
      help: 'Identities by profile status, all tenants; soft-deleted ones as DELETED',
      labelNames: ['status'],
      registers: [this.registry],
      collect: this.collectCount('euroid_identities_total', 'status'),
    });

    this.identityOperationsTotal = new Counter({
      name: 'euroid_identity_operations_total',
      help: 'Identity lifecycle operations',
      labelNames: ['operation'],
      registers: [this.registry],
    });

    // ── HTTP Request Performance ──────────────────
    this.httpRequestDuration = new Histogram({
      name: 'euroid_http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    this.httpRequestsTotal = new Counter({
      name: 'euroid_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    // ── Access Requests ───────────────────────────
    this.accessRequestsTotal = new Counter({
      name: 'euroid_access_requests_total',
      help: 'Total access requests by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.accessRequestsPending = new Gauge({
      name: 'euroid_access_requests_pending',
      help: 'Access requests waiting for approval (PENDING_APPROVAL), all tenants',
      registers: [this.registry],
      collect: this.collectCount('euroid_access_requests_pending'),
    });

    // ── Access Reviews ────────────────────────────
    this.accessReviewDecisionsTotal = new Counter({
      name: 'euroid_access_review_decisions_total',
      help: 'Access review decisions by type',
      labelNames: ['decision'],
      registers: [this.registry],
    });

    this.accessReviewCampaignsActive = new Gauge({
      name: 'euroid_access_review_campaigns_active',
      help: 'Access review campaigns in status ACTIVE, all tenants',
      registers: [this.registry],
      collect: this.collectCount('euroid_access_review_campaigns_active'),
    });

    // ── Anomaly Detection ─────────────────────────
    this.anomaliesDetectedTotal = new Counter({
      name: 'euroid_anomalies_detected_total',
      help: 'Total anomalies detected by type and severity',
      labelNames: ['type', 'severity'],
      registers: [this.registry],
    });

    // ── Mover Workflow ────────────────────────────
    this.moverOperationsTotal = new Counter({
      name: 'euroid_mover_operations_total',
      help: 'Mover workflow operations by status',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.moverDuration = new Histogram({
      name: 'euroid_mover_duration_ms',
      help: 'Mover workflow duration in milliseconds',
      buckets: HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });
  }

  /**
   * Sets `gauge` from `count` each time Prometheus scrapes, so it is what the database holds then
   * (euroid_access_requests_pending: every way out of PENDING_APPROVAL lowers it). Registered by
   * AccessRequestsModule, IdentityModule and AccessReviewModule; unregistered, a gauge stays 0.
   */
  countAtScrape(gauge: ScrapeCountedGauge, count: ScrapeCount): void {
    this.counts.set(gauge, count);
  }

  /**
   * The collect function of a scrape-counted gauge. A count per label value replaces all of the
   * gauge's values (a status nobody has any more disappears); a failed count keeps the last values
   * and the scrape still answers.
   */
  private collectCount(gauge: ScrapeCountedGauge, label?: string) {
    const counts = this.counts;
    const logger = this.logger;
    return async function collect(this: Gauge): Promise<void> {
      const count = counts.get(gauge);
      if (!count) return;
      try {
        const value = await count();
        if (typeof value === 'number') {
          this.set(value);
          return;
        }
        this.reset();
        for (const [key, n] of Object.entries(value)) this.set({ [label ?? 'value']: key }, n);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`${gauge} not counted: ${message}`);
      }
    };
  }
}
