/**
 * Health Check Endpoints
 *
 * Liveness (/health): Proves the process is alive. No external calls.
 * Readiness (/health/ready): Checks MongoDB + connector staleness (counts by status, cached from
 * the DB, no connector named) + whether the security state store (lockout counters, SAML codes)
 * is failing + whether a configured access graph (Neo4j) is connected.
 * Both are @Public() — no auth required for load balancers and Kubernetes probes.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import { SECURITY_STATE_STORE, type SecurityStateStore } from '../cache/security-state.store';
import { GraphService } from '../graph/graph.service';

@ApiTags('Health')
@Controller('health')
@SkipThrottle() // Health probes must not be rate-limited (K8s, load balancers)
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly healthService: HealthService,
    @Inject(SECURITY_STATE_STORE) private readonly securityState: SecurityStateStore,
    private readonly graphService: GraphService,
  ) {}

  /**
   * Liveness probe. Returns immediately with process uptime.
   * No external calls. Target: <10ms.
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe' })
  liveness() {
    return {
      status: 'ok',
      uptime: process.uptime(),
    };
  }

  /**
   * Readiness probe. Checks MongoDB + connector staleness (counts, cached from DB; not read while
   * MongoDB is down, so the 503 comes at once instead of after a buffered query) + the security
   * state store's last result (no call to it) + the access graph's connection state (no call to
   * Neo4j; while it is not connected the graph service starts its next attempt in the background
   * when one is due). Target: <100ms. Never waits for an external API.
   */
  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe' })
  async readiness() {
    const mongodbStatus = this.connection.readyState === 1 ? 'ok' : 'unhealthy';
    const connectorStatuses =
      mongodbStatus === 'ok'
        ? await this.healthService.getConnectorSummary()
        : HealthService.notChecked();
    const securityState = this.securityState.health();
    const graph = { status: this.graphService.connectionState() };
    const { overallStatus, httpStatus } = this.healthService.computeOverallStatus(
      mongodbStatus,
      connectorStatuses,
      securityState.status,
      graph.status,
    );

    const res = {
      status: overallStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      components: {
        mongodb: { status: mongodbStatus },
        connectors: connectorStatuses,
        securityState,
        graph,
      },
    };

    if (httpStatus === HttpStatus.SERVICE_UNAVAILABLE) {
      throw new ServiceUnavailableException(res);
    }
    return res;
  }
}
