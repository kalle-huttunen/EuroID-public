/**
 * The readiness probe reports the access graph's connection state as components.graph, read from
 * GraphService without waiting for Neo4j; a configured graph that is not connected makes it
 * degraded (HTTP 200). It is public, so its connector part is counts only (hunt 07 F6), and with
 * MongoDB down it answers the structured 503 at once instead of waiting on a connector read
 * (hunt r2-07 N11).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { Connection } from 'mongoose';
import type { GraphService } from '../graph/graph.service';
import type { SecurityStateStore } from '../cache/security-state.store';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

function controllerWith(
  graphState: ReturnType<GraphService['connectionState']>,
  readyState = 1,
  connectorRows: unknown[] = [],
) {
  const exec = jest.fn().mockResolvedValue(connectorRows);
  const query = { setOptions: () => query, lean: () => query, exec };
  const configModel = { find: jest.fn().mockReturnValue(query) };
  const healthService = new HealthService(
    configModel as never,
    { findAll: jest.fn().mockResolvedValue([]) } as never,
  );
  const securityState = {
    health: () => ({ status: 'ok', backend: 'memory', failures: 0 }),
  } as unknown as SecurityStateStore;
  const graph = { connectionState: jest.fn(() => graphState) };
  const controller = new HealthController(
    { readyState } as unknown as Connection,
    healthService,
    securityState,
    graph as unknown as GraphService,
  );
  return { controller, graph, configModel };
}

describe('HealthController readiness', () => {
  it('reports a graph that is not connected and is degraded', async () => {
    const { controller, graph } = controllerWith('not-connected');

    const res = await controller.readiness();

    expect(res.status).toBe('degraded');
    expect(res.components.graph).toEqual({ status: 'not-connected' });
    expect(graph.connectionState).toHaveBeenCalled();
  });

  it('is ok with a connected graph or none configured', async () => {
    for (const state of ['ok', 'not-configured'] as const) {
      const res = await controllerWith(state).controller.readiness();

      expect(res.status).toBe('ok');
      expect(res.components.graph).toEqual({ status: state });
    }
  });

  it('answers connector counts only: no connector name, tenant or sync time', async () => {
    const { controller } = controllerWith('not-configured', 1, [
      { tenantId: 'acme', lastSyncAt: new Date('2020-01-01T00:00:00Z'), lastSyncStatus: 'success' },
      { tenantId: 'acme', lastSyncAt: new Date(), lastSyncStatus: 'success' },
    ]);

    const res = await controller.readiness();

    expect(res.status).toBe('degraded'); // a stale connector still shows
    expect(res.components.connectors).toEqual({
      ok: 1,
      stale: 1,
      unknown: 0,
      checkedAt: expect.any(String),
    });
    expect(JSON.stringify(res)).not.toContain('acme');
    expect(JSON.stringify(res)).not.toContain('2020-01-01');
  });

  it('answers 503 with the components at once while MongoDB is down, reading no connector', async () => {
    const { controller, configModel } = controllerWith('not-configured', 0);

    const error = await controller.readiness().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      status: 'unhealthy',
      components: {
        mongodb: { status: 'unhealthy' },
        connectors: { ok: 0, stale: 0, unknown: 0, checkedAt: null },
      },
    });
    expect(configModel.find).not.toHaveBeenCalled();
  });
});
