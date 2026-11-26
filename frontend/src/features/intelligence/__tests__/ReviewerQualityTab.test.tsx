/**
 * The Reviewer quality tab of Access reviews: each reviewer's score per completed campaign with
 * the signals behind it (GET /intelligence/reviewer-quality), one campaign's scores
 * (GET /intelligence/reviewer-quality/:campaignId) from the filter or from a completed campaign's
 * modal, paging, the empty, loading and error states, and the role gate: both routes need
 * super-admin, so a policy-admin is offered neither the tab nor the link and sends no request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from 'antd';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { AccessReviews } from '../AccessReviews';
import type { IReviewerQualityScore } from '../../../interfaces';
import {
  CAMPAIGNS,
  SCORES,
  apiError,
  carefulReviewer,
  choose,
  dialog,
  financeCampaign,
  offeredOptions,
  q3Campaign,
  quickApprover,
  rubberStamper,
  slowThresholdReviewer,
  smallBulkWindowReviewer,
} from './access-intelligence.fixtures';

let mockIsSuperAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'super-admin' ? mockIsSuperAdmin : true),
}));

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}));

const QUALITY = /\/intelligence\/reviewer-quality(\/[^/?]+)?$/;
type Params = { page?: number; limit?: number };
let scoresAnswer: (url: string, params: Params) => Promise<unknown>;

/** The routes' answer: the campaign's scores (or all), lowest first, one page. */
const serveScores = (scores: IReviewerQualityScore[], total?: number) => {
  scoresAnswer = (url, params) => {
    const campaignId = QUALITY.exec(url)?.[1]?.slice(1);
    const rows = scores
      .filter((s) => !campaignId || s.campaignId === campaignId)
      .sort((a, b) => a.qualityScore - b.qualityScore);
    return Promise.resolve({
      data: { data: rows, total: total ?? rows.length, page: params.page },
    });
  };
};

const qualityCalls = () => mockGet.mock.calls.filter(([url]) => QUALITY.test(url as string));
const lastQualityCall = () => {
  const call = qualityCalls().at(-1);
  return call && { url: call[0] as string, params: (call[1] as { params: Params }).params };
};

function renderPage() {
  return renderWithProviders(
    <ConfigProvider virtual={false}>
      <AccessReviews />
    </ConfigProvider>,
  );
}

async function openQualityTab() {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('tab', { name: 'Reviewer quality' }));
  return user;
}

const scoresTable = () => screen.findByRole('table', { name: 'Reviewer quality scores' });
const rowOf = (table: HTMLElement, reviewer: string) =>
  within(table).getByText(reviewer).closest('tr') as HTMLElement;

describe('Reviewer quality tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSuperAdmin = true;
    serveScores(SCORES);
    mockGet.mockImplementation((url: string, config?: { params?: Params }) => {
      if (QUALITY.test(url)) return scoresAnswer(url, config?.params ?? {});
      if (url.includes(`/campaigns/${q3Campaign.campaignId}`)) {
        return Promise.resolve({ data: q3Campaign });
      }
      if (url.includes('/campaigns')) {
        return Promise.resolve({ data: { data: CAMPAIGNS, total: CAMPAIGNS.length } });
      }
      return Promise.resolve({ data: { data: [], total: 0 } });
    });
  });

  it('shows each reviewer’s score, the signals that cost points and when it was scored', async () => {
    await openQualityTab();
    const table = await scoresTable();

    expect(lastQualityCall()).toEqual({
      url: '/api/v1/intelligence/reviewer-quality',
      params: { page: 1, limit: 20 },
    });
    const stamper = rowOf(table, rubberStamper.reviewerId);
    expect(within(stamper).getByText(q3Campaign.name)).toBeInTheDocument();
    expect(within(stamper).getByText('25 · Low')).toBeInTheDocument();
    expect(within(stamper).getByText('Approves over 95% (−30)')).toBeInTheDocument();
    expect(within(stamper).getByText('Decides in under 30 s (−25)')).toBeInTheDocument();
    expect(within(stamper).getByText('10 approvals within 5 min (−20)')).toBeInTheDocument();
    expect(within(stamper).queryByText(/Most approvals unjustified/)).toBeNull();
    expect(within(stamper).getByText('100%')).toBeInTheDocument();
    expect(within(stamper).getByText('8 s')).toBeInTheDocument();
    expect(within(stamper).getByText('20%')).toBeInTheDocument();
    expect(within(stamper).getByText('3')).toBeInTheDocument();
    expect(
      within(stamper).getByText(dayjs(rubberStamper.calculatedAt).format('YYYY-MM-DD HH:mm')),
    ).toBeInTheDocument();

    // 70 is not above 70: medium, like the backend's trust levels.
    const quick = rowOf(table, quickApprover.reviewerId);
    expect(within(quick).getByText(financeCampaign.name)).toBeInTheDocument();
    expect(within(quick).getByText('70 · Medium')).toBeInTheDocument();
    expect(within(quick).getByText('10 min')).toBeInTheDocument();

    const careful = rowOf(table, carefulReviewer.reviewerId);
    expect(within(careful).getByText('100 · High')).toBeInTheDocument();
    expect(within(careful).getByText('No warning signs')).toBeInTheDocument();
    expect(within(careful).getByText('2 h')).toBeInTheDocument();

    // Read-only: nothing on the tab changes a campaign or a decision.
    expect(within(table).queryByRole('button')).toBeNull();
  });

  it('names the decision time threshold the score was computed with', async () => {
    serveScores([slowThresholdReviewer, quickApprover]);
    await openQualityTab();
    const table = await scoresTable();

    // INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS was 60 s: 45 s on average cost 25 points.
    const slow = rowOf(table, slowThresholdReviewer.reviewerId);
    expect(within(slow).getByText('75 · High')).toBeInTheDocument();
    expect(within(slow).getByText('Decides in under 60 s (−25)')).toBeInTheDocument();
    // A score without the recorded threshold was computed with 30 s.
    const quick = rowOf(table, quickApprover.reviewerId);
    expect(within(quick).queryByText(/Decides in under/)).toBeNull();
  });

  // FOLLOWUPS 2026-11-25 (access-intelligence-labels.ts:67): the label said 10 whatever counted
  it('names the bulk approval rule the score was computed with', async () => {
    serveScores([smallBulkWindowReviewer, rubberStamper]);
    await openQualityTab();
    const table = await scoresTable();

    // INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT was 4: four approvals within 5 minutes cost 20 points.
    const small = rowOf(table, smallBulkWindowReviewer.reviewerId);
    expect(within(small).getByText('80 · High')).toBeInTheDocument();
    expect(within(small).getByText('4 approvals within 5 min (−20)')).toBeInTheDocument();
    // A score without the recorded rule was computed with 10 approvals within 5 minutes.
    const stamper = rowOf(table, rubberStamper.reviewerId);
    expect(within(stamper).getByText('10 approvals within 5 min (−20)')).toBeInTheDocument();
  });

  it('reads one completed campaign’s scores from its own route', { timeout: 15_000 }, async () => {
    const user = await openQualityTab();
    await scoresTable();

    const box = screen.getByRole('combobox', { name: 'Campaign' });
    await user.click(box);
    // Only completed campaigns are scored: the active Q4 campaign is not offered.
    await waitFor(() => expect(offeredOptions()).toEqual([q3Campaign.name, financeCampaign.name]));
    await choose(box, financeCampaign.name);

    await waitFor(() =>
      expect(lastQualityCall()).toEqual({
        url: `/api/v1/intelligence/reviewer-quality/${financeCampaign.campaignId}`,
        params: { page: 1, limit: 20 },
      }),
    );
    const table = await scoresTable();
    await waitFor(() => expect(within(table).queryByText(rubberStamper.reviewerId)).toBeNull());
    expect(within(table).getByText(quickApprover.reviewerId)).toBeInTheDocument();
  });

  it('pages through the scores on the server', { timeout: 15_000 }, async () => {
    serveScores(SCORES, 45);
    const user = await openQualityTab();
    await scoresTable();

    await user.click(screen.getByTitle('2'));
    await waitFor(() => expect(lastQualityCall()?.params).toEqual({ page: 2, limit: 20 }));
  });

  it(
    'starts another campaign, from its modal, on its first page',
    { timeout: 20_000 },
    async () => {
      serveScores(SCORES, 45);
      const user = await openQualityTab();
      await scoresTable();
      await user.click(screen.getByTitle('2'));
      await waitFor(() => expect(lastQualityCall()?.params.page).toBe(2));

      await user.click(screen.getByRole('tab', { name: 'Campaigns' }));
      // The scores tab stays mounted with the campaign's name in its rows: take the campaigns row.
      const campaignRow = await waitFor(() => {
        const row = screen
          .getAllByText(q3Campaign.name)
          .map((el) => el.closest('tr'))
          .find((tr) => tr && within(tr).queryByRole('button', { name: 'View' }));
        if (!row) throw new Error('no campaign row');
        return row;
      });
      await user.click(within(campaignRow).getByRole('button', { name: 'View' }));
      await user.click(
        within(await dialog(q3Campaign.name)).getByRole('button', { name: 'Reviewer quality' }),
      );

      await waitFor(() =>
        expect(lastQualityCall()).toEqual({
          url: `/api/v1/intelligence/reviewer-quality/${q3Campaign.campaignId}`,
          params: { page: 1, limit: 20 },
        }),
      );
    },
  );

  it('opens on a completed campaign from its modal', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    renderPage();
    const campaignRow = (await screen.findByText(q3Campaign.name)).closest('tr') as HTMLElement;
    await user.click(within(campaignRow).getByRole('button', { name: 'View' }));
    const modal = await dialog(q3Campaign.name);
    await user.click(within(modal).getByRole('button', { name: 'Reviewer quality' }));

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Reviewer quality' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await waitFor(() =>
      expect(lastQualityCall()?.url).toBe(
        `/api/v1/intelligence/reviewer-quality/${q3Campaign.campaignId}`,
      ),
    );
    const table = await scoresTable();
    expect(within(table).getByText(rubberStamper.reviewerId)).toBeInTheDocument();
    expect(within(table).queryByText(quickApprover.reviewerId)).toBeNull();
  });

  it('says when campaigns are scored when there is no score yet', async () => {
    serveScores([]);
    await openQualityTab();

    expect(await screen.findByText('No reviewer scores yet')).toBeInTheDocument();
    expect(screen.getByText(/the night after it completes/)).toBeInTheDocument();
    expect(screen.getByText(/04:00 UTC by default/)).toBeInTheDocument();
    // No route computes scores on demand, so nothing offers to.
    expect(screen.queryByRole('button', { name: /compute|score now/i })).toBeNull();
  });

  it(
    'tells a campaign without scores apart and goes back to all campaigns',
    { timeout: 15_000 },
    async () => {
      serveScores([rubberStamper]);
      const user = await openQualityTab();
      await scoresTable();
      await choose(screen.getByRole('combobox', { name: 'Campaign' }), financeCampaign.name);

      expect(await screen.findByText('No scores for this campaign')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show all campaigns' }));
      await waitFor(() =>
        expect(lastQualityCall()?.url).toBe('/api/v1/intelligence/reviewer-quality'),
      );
      expect(await scoresTable()).toBeInTheDocument();
    },
  );

  it('shows a skeleton while the scores load', async () => {
    scoresAnswer = () => new Promise(() => {});
    await openQualityTab();

    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Reviewer quality' }).querySelector('.ant-skeleton'),
      ).not.toBeNull(),
    );
  });

  it('shows the API’s message when the scores cannot be loaded', async () => {
    scoresAnswer = () => Promise.reject(apiError(403, 'Requires one of: super-admin'));
    await openQualityTab();

    expect(await screen.findByText('Could not load the reviewer scores')).toBeInTheDocument();
    expect(screen.getByText('Requires one of: super-admin')).toBeInTheDocument();
  });

  it('reads the scores again on Refresh', async () => {
    const user = await openQualityTab();
    await scoresTable();
    const before = qualityCalls().length;

    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(qualityCalls().length).toBe(before + 1));
  });

  it(
    'offers a policy-admin neither the tab nor the link, and sends no score request',
    { timeout: 20_000 },
    async () => {
      mockIsSuperAdmin = false;
      const user = userEvent.setup();
      renderPage();

      const campaignRow = (await screen.findByText(q3Campaign.name)).closest('tr') as HTMLElement;
      expect(screen.getByRole('tab', { name: 'My Reviews' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Reviewer quality' })).toBeNull();
      await user.click(within(campaignRow).getByRole('button', { name: 'View' }));
      const modal = await dialog(q3Campaign.name);
      await within(modal).findByText('COMPLETED');
      expect(within(modal).queryByRole('button', { name: 'Reviewer quality' })).toBeNull();
      expect(qualityCalls()).toHaveLength(0);
    },
  );
});
