/**
 * Gauges counted when Prometheus scrapes, from a count the owning module registers
 * (countAtScrape): euroid_access_requests_pending (AccessRequestsModule), euroid_identities_total
 * per status (IdentityModule) and euroid_access_review_campaigns_active (AccessReviewModule).
 * Before, the pending gauge rose on access_request.created and nothing lowered it (most requests
 * leave PENDING_APPROVAL in the worker, which serves no /metrics), and the other two were never set.
 */
import { Logger } from '@nestjs/common';
import { MetricsService, type ScrapeCountedGauge } from './metrics.service';

describe('MetricsService: gauges counted at scrape', () => {
  const values = async (metrics: MetricsService, gauge: ScrapeCountedGauge) =>
    (await metrics.registry.getSingleMetric(gauge)!.get()).values;
  const value = async (metrics: MetricsService, gauge: ScrapeCountedGauge) =>
    (await values(metrics, gauge))[0]?.value;

  afterEach(() => jest.restoreAllMocks());

  it('euroid_access_requests_pending follows the count, down as well as up', async () => {
    const metrics = new MetricsService();
    let count = 3;
    metrics.countAtScrape('euroid_access_requests_pending', async () => count);

    expect(await value(metrics, 'euroid_access_requests_pending')).toBe(3);
    // Approved, rejected, cancelled, expired or failed: no longer pending
    count = 1;
    expect(await value(metrics, 'euroid_access_requests_pending')).toBe(1);
    expect(await metrics.registry.metrics()).toContain('euroid_access_requests_pending 1');
  });

  it('euroid_identities_total has one value per status, a status nobody has any more gone', async () => {
    const metrics = new MetricsService();
    let counts: Record<string, number> = { ACTIVE: 40, TERMINATED: 2, DELETED: 1 };
    metrics.countAtScrape('euroid_identities_total', async () => counts);

    const byStatus = async () =>
      Object.fromEntries(
        (await values(metrics, 'euroid_identities_total')).map((v) => [v.labels.status, v.value]),
      );
    expect(await byStatus()).toEqual({ ACTIVE: 40, TERMINATED: 2, DELETED: 1 });
    counts = { ACTIVE: 41, DELETED: 3 };
    expect(await byStatus()).toEqual({ ACTIVE: 41, DELETED: 3 });
  });

  it('euroid_access_review_campaigns_active is the count of active campaigns', async () => {
    const metrics = new MetricsService();
    metrics.countAtScrape('euroid_access_review_campaigns_active', async () => 2);

    expect(await value(metrics, 'euroid_access_review_campaigns_active')).toBe(2);
  });

  it('keeps the last value, and the scrape answers, when a count fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const metrics = new MetricsService();
    let fail = false;
    metrics.countAtScrape('euroid_access_requests_pending', async () => {
      if (fail) throw new Error('MongoDB unreachable');
      return 2;
    });
    expect(await value(metrics, 'euroid_access_requests_pending')).toBe(2);

    fail = true;

    await expect(metrics.registry.metrics()).resolves.toContain('euroid_access_requests_pending 2');
    expect(warn).toHaveBeenCalledWith(
      'euroid_access_requests_pending not counted: MongoDB unreachable',
    );
  });

  it('is 0 while nothing registered a count', async () => {
    expect(await value(new MetricsService(), 'euroid_access_review_campaigns_active')).toBe(0);
  });
});
