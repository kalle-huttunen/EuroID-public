import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { UncorrelatedQueue } from '../UncorrelatedQueue';
import type { IScoredCandidate, IUncorrelatedIdentity } from '../../../interfaces';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const record: IUncorrelatedIdentity = {
  _id: '64b7f0c2a1b2c3d4e5f60010',
  firstName: 'Matti',
  lastName: 'Virtanen',
  email: 'matti.virtanen@corp.example',
  departmentName: 'Finance',
  jobTitle: 'Controller',
  metadata: { correlationStatus: 'ambiguous', ambiguousCandidates: ['a', 'b'] },
  sources: [{ sourceName: 'csv-hr', externalId: 'E100' }],
};

const candidate: IScoredCandidate = {
  identityId: '64b7f0c2a1b2c3d4e5f60020',
  profile: { firstName: 'Matti', lastName: 'Virtanen', email: 'mvirtanen@corp.example' },
  matchedBy: 'name',
  confidence: 0.82,
  sources: [{ sourceName: 'entra-id', externalId: 'aad-1' }],
};

/** GET answers of the queue page, the queue holding `queue`. */
function serveQueue(queue: IUncorrelatedIdentity[]) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/identity/uncorrelated')) return Promise.resolve({ data: queue });
    if (url.endsWith('/identity/uncorrelated/count'))
      return Promise.resolve({ data: { count: queue.length } });
    if (url.endsWith(`/identity/${record._id}/candidates`)) {
      return Promise.resolve({ data: { candidates: [candidate] } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('UncorrelatedQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serveQueue([record]);
    mockPost.mockResolvedValue({ data: {} });
  });

  it(
    'opens the record and its candidates in a centered modal and links after confirmation',
    { timeout: 20_000 },
    async () => {
      // 3.dn: the owner chose centered modals over side drawers for read-and-act views.
      const user = userEvent.setup();
      renderWithProviders(<UncorrelatedQueue />);

      await user.click(await screen.findByRole('button', { name: /Link$/ }));

      expect(await screen.findByText('Link Identity: Matti Virtanen')).toBeInTheDocument();
      expect(document.querySelector('.ant-drawer')).toBeNull();
      const modal = document.querySelector('.ant-modal') as HTMLElement;
      expect(modal).toHaveStyle({ width: '880px' });
      const footer = modal.querySelector('.ant-modal-footer') as HTMLElement;
      expect(
        within(footer).getByRole('button', { name: /Create as New Person$/ }),
      ).toBeInTheDocument();
      expect(await within(modal).findByText('mvirtanen@corp.example')).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: /Link This One$/ }));
      const confirm = (await screen.findByText('Confirm Link')).closest(
        '.ant-modal',
      ) as HTMLElement;
      await user.click(within(confirm).getByRole('button', { name: /^Link$/ }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(`/identity/${record._id}/link$`),
          { targetIdentityId: candidate.identityId },
        ),
      );
    },
  );

  it(
    'offers Close, which records nothing and leaves the record in the queue',
    { timeout: 20_000 },
    async () => {
      // 2.0dj: [Skip / Ignore] only closed the modal; no "ignored" state exists to record
      const user = userEvent.setup();
      renderWithProviders(<UncorrelatedQueue />);

      await user.click(await screen.findByRole('button', { name: /Link$/ }));
      const modal = (await screen.findByText('Link Identity: Matti Virtanen')).closest(
        '.ant-modal',
      ) as HTMLElement;
      const footer = modal.querySelector('.ant-modal-footer') as HTMLElement;
      expect(within(footer).queryByRole('button', { name: /Skip|Ignore/ })).toBeNull();

      await user.click(within(footer).getByRole('button', { name: /^Close$/ }));

      await waitFor(() => expect(screen.queryByText('Link Identity: Matti Virtanen')).toBeNull());
      expect(mockPost).not.toHaveBeenCalled();
      expect(screen.getByRole('cell', { name: 'Matti Virtanen' })).toBeInTheDocument();
    },
  );

  it(
    'says before linking that the merge cannot be undone from the UI',
    { timeout: 20_000 },
    async () => {
      // The text promised a "manual split later"; no split exists for a link (Split on a
      // conflict card only clears its flags), and the HR record's own identity is deleted.
      const user = userEvent.setup();
      renderWithProviders(<UncorrelatedQueue />);

      await user.click(await screen.findByRole('button', { name: /Link$/ }));
      const modal = (await screen.findByText('Link Identity: Matti Virtanen')).closest(
        '.ant-modal',
      ) as HTMLElement;
      await user.click(await within(modal).findByRole('button', { name: /Link This One$/ }));
      const confirm = (await screen.findByText('Confirm Link')).closest(
        '.ant-modal',
      ) as HTMLElement;

      expect(
        within(confirm).getByText(/A link cannot be undone from the UI\./),
      ).toBeInTheDocument();
      expect(within(confirm).queryByText(/split/i)).toBeNull();
      expect(mockPost).not.toHaveBeenCalled();
    },
  );

  it(
    'tags an offboarded identity as ready to link and offers Keep Separate instead of a new person',
    { timeout: 20_000 },
    async () => {
      // Link refuses an identity with accounts, so the admin deletes it first; once offboarded
      // it stays in the queue (it used to leave it, and its HR record was ignored from then on)
      serveQueue([{ ...record, offboarded: true }]);
      const user = userEvent.setup();
      renderWithProviders(<UncorrelatedQueue />);

      expect(await screen.findByText('Offboarded, ready to link')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Link$/ }));
      const modal = (await screen.findByText('Link Identity: Matti Virtanen')).closest(
        '.ant-modal',
      ) as HTMLElement;
      const footer = modal.querySelector('.ant-modal-footer') as HTMLElement;
      expect(within(footer).queryByRole('button', { name: /Create as New Person$/ })).toBeNull();

      await user.click(within(footer).getByRole('button', { name: /Keep Separate$/ }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(`/identity/${record._id}/create-standalone$`),
        ),
      );
    },
  );

  it('shows no offboarded tag for a live identity', { timeout: 20_000 }, async () => {
    renderWithProviders(<UncorrelatedQueue />);

    expect(await screen.findByRole('cell', { name: 'Matti Virtanen' })).toBeInTheDocument();
    expect(screen.queryByText('Offboarded, ready to link')).toBeNull();
  });
});
