/**
 * Deleting a policy from the list asks for confirmation first and only then sends the DELETE.
 * The confirmation used the static Modal.confirm, which renders nothing under React 19, so a
 * policy could not be deleted from the list (2.0dh). A policy whose grants reviewers revoked in
 * access reviews shows how often (review exclusions counted against the granting policy).
 *
 * Every policy is created as a draft, the toggle refuses a draft (400), and a draft goes live only
 * through POST /policy/:id/activate by a policy admin other than the one who wrote its grants
 * (segregation of duties). Without an Activate action on the page a rule created in the UI could
 * never go live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { PolicyList } from '../PolicyList';

const POLICY_ID = '64b7f0c2a1b2c3d4e5f60900';
const policy = {
  _id: POLICY_ID,
  name: 'Joiner baseline',
  description: 'Access every joiner gets',
  status: 'active',
  priority: 3,
  risk: 'Low',
  conditionGroups: [],
  actions: [],
  createdBy: 'admin@euroid.local',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
};

/** The signed-in admin of renderWithProviders. */
const ME = 'admin@euroid.local';
const OTHER_ADMIN = 'other-admin@euroid.local';
const draft = { ...policy, status: 'draft', createdBy: OTHER_ADMIN };

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

/** The API lists these policies; each matches 3 identities. */
function serve(policies: object[]) {
  mockGet.mockImplementation(async (url: string) =>
    url.endsWith('/impact') ? { data: { matchedCount: 3 } } : { data: policies },
  );
}

const renderList = () =>
  renderWithProviders(
    <PolicyList onEditPolicy={vi.fn()} onPreviewPolicy={vi.fn()} onCreatePolicy={vi.fn()} />,
  );

describe('PolicyList', () => {
  beforeEach(() => {
    mockGet
      .mockReset()
      .mockImplementation(async (url: string) =>
        url.endsWith('/impact') ? { data: { matchedCount: 3 } } : { data: [policy] },
      );
    mockDelete.mockReset().mockResolvedValue({ data: {} });
    mockPost.mockReset().mockResolvedValue({ data: {} });
  });

  // The table, menu and dialog take a few seconds to render in jsdom.
  // 2.0dt: the delete refreshed every policy query, the deleted policy's impact count too, which
  // the API answered with 404.
  it('deletes a policy once its confirmation is accepted', { timeout: 20_000 }, async () => {
    const impactUrl = `/api/v1/policy/${POLICY_ID}/impact`;
    const impactRequests = () => mockGet.mock.calls.filter(([url]) => url === impactUrl).length;
    const user = userEvent.setup();
    renderWithProviders(
      <PolicyList onEditPolicy={vi.fn()} onPreviewPolicy={vi.fn()} onCreatePolicy={vi.fn()} />,
    );
    await screen.findByText('Joiner baseline');
    await waitFor(() => expect(impactRequests()).toBe(1));
    // Once deleted, the API lists the policy no more.
    mockGet.mockImplementation(async (url: string) =>
      url.endsWith('/impact') ? { data: { matchedCount: 3 } } : { data: [] },
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete$/ }));
    // antd also puts the confirm's title in a hidden modal title; match the visible one.
    const dialog = (
      await screen.findByText('Delete this policy?', { selector: '.ant-modal-confirm-title' })
    ).closest('.ant-modal') as HTMLElement;
    expect(
      within(dialog).getByText('"Joiner baseline" will be permanently removed.'),
    ).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(`/api/v1/policy/${POLICY_ID}`));
    await waitFor(() => expect(screen.queryByText('Joiner baseline')).not.toBeInTheDocument());
    // The deleted policy's impact count is not asked for again.
    expect(impactRequests()).toBe(1);
  });

  it('shows how often reviewers revoked what a policy grants', { timeout: 20_000 }, async () => {
    mockGet.mockImplementation(async (url: string) =>
      url.endsWith('/impact')
        ? { data: { matchedCount: 3 } }
        : url === '/api/v1/policy/review-exclusions/counts'
          ? {
              data: {
                counts: [
                  { policyId: POLICY_ID, policyName: 'Joiner baseline', active: 2, lifted: 1 },
                ],
              },
            }
          : { data: [policy] },
    );
    renderWithProviders(
      <PolicyList onEditPolicy={vi.fn()} onPreviewPolicy={vi.fn()} onCreatePolicy={vi.fn()} />,
    );

    expect(await screen.findByText(/3 revoked in reviews/)).toBeInTheDocument();
  });

  describe('activating a draft', () => {
    it(
      'offers Activate on a draft row and activates it through the activate route',
      { timeout: 20_000 },
      async () => {
        serve([draft]);
        const user = userEvent.setup();
        renderList();
        await screen.findByText('Joiner baseline');
        // The toggle refuses a draft; its tooltip points at Activate.
        const toggle = screen.getByRole('switch');
        expect(toggle).toBeDisabled();
        await user.hover(toggle);
        expect(await screen.findByRole('tooltip')).toHaveTextContent(/Activate/);

        await user.click(screen.getByRole('button', { name: 'Activate Joiner baseline' }));
        const dialog = (
          await screen.findByText('Activate this policy?', {
            selector: '.ant-modal-confirm-title',
          })
        ).closest('.ant-modal') as HTMLElement;
        expect(within(dialog).getByText(/"Joiner baseline" goes live/)).toBeInTheDocument();
        expect(within(dialog).getByText(/matches 3 identities/)).toBeInTheDocument();
        expect(mockPost).not.toHaveBeenCalled();
        // Once activated, the API lists the policy as active.
        serve([{ ...draft, status: 'active' }]);
        await user.click(within(dialog).getByRole('button', { name: 'Activate' }));

        await waitFor(() =>
          expect(mockPost).toHaveBeenCalledWith(`/api/v1/policy/${POLICY_ID}/activate`),
        );
        expect(await screen.findByText('Policy activated')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
        expect(screen.getByRole('switch')).toBeChecked();
        expect(
          screen.queryByRole('button', { name: 'Activate Joiner baseline' }),
        ).not.toBeInTheDocument();
      },
    );

    it('disables Activate for the admin who created the draft', { timeout: 20_000 }, async () => {
      serve([{ ...draft, createdBy: ME }]);
      const user = userEvent.setup();
      renderList();

      const activate = await screen.findByRole('button', { name: 'Activate Joiner baseline' });
      expect(activate).toBeDisabled();
      await user.hover(activate);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Another policy admin must activate a rule you created.',
      );
    });

    // The API checks the last editor of the conditions, actions or role bundle, and only for a
    // policy never so edited its creator.
    it('disables Activate for the last editor of the grants', { timeout: 20_000 }, async () => {
      serve([{ ...draft, createdBy: OTHER_ADMIN, lastEditedBy: ME }]);
      renderList();

      const activate = await screen.findByRole('button', { name: 'Activate Joiner baseline' });
      expect(activate).toBeDisabled();
    });

    it(
      'lets the creator activate a draft another admin last edited',
      { timeout: 20_000 },
      async () => {
        serve([{ ...draft, createdBy: ME, lastEditedBy: OTHER_ADMIN }]);
        renderList();

        const activate = await screen.findByRole('button', { name: 'Activate Joiner baseline' });
        expect(activate).toBeEnabled();
      },
    );

    it(
      'shows the API message when the activation is refused and stops spinning',
      { timeout: 20_000 },
      async () => {
        serve([draft]);
        const refusal =
          'Segregation of Duties: The policy creator cannot activate their own policy.';
        mockPost.mockRejectedValue({ response: { status: 403, data: { message: refusal } } });
        const user = userEvent.setup();
        renderList();

        await user.click(await screen.findByRole('button', { name: 'Activate Joiner baseline' }));
        const dialog = (
          await screen.findByText('Activate this policy?', {
            selector: '.ant-modal-confirm-title',
          })
        ).closest('.ant-modal') as HTMLElement;
        await user.click(within(dialog).getByRole('button', { name: 'Activate' }));

        expect(await screen.findByText(refusal)).toBeInTheDocument();
        const activate = screen.getByRole('button', { name: 'Activate Joiner baseline' });
        expect(activate).toBeEnabled();
        expect(activate).not.toHaveClass('ant-btn-loading');
        expect(screen.getByRole('switch')).toBeDisabled();
      },
    );

    it('offers no Activate on an active row', { timeout: 20_000 }, async () => {
      serve([policy]);
      renderList();

      await screen.findByText('Joiner baseline');
      expect(screen.queryByRole('button', { name: /^Activate/ })).not.toBeInTheDocument();
      expect(screen.getByRole('switch')).toBeEnabled();
      expect(screen.getByRole('switch')).toBeChecked();
    });
  });
});
