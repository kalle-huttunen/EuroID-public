/**
 * GdprPage erasure (super-admin): one dry run when the modal opens, what is deleted and what stays,
 * the person's identifier typed in before the erasure, the X-Confirm-Erasure header, the
 * attestation afterwards, the reloads, and the API's message on a refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { GdprPage } from '../GdprPage';
import {
  ADA_ADMIN_ID,
  ADA_EMAIL,
  ADA_ID,
  ADA_LABEL,
  IDENTITY_LIST,
  apiError,
  attestation,
  preview,
  expectReloaded,
  loads,
  mockDelete,
  mockGet,
  mockPost,
  modalTitled,
  pickPerson,
  serve,
} from './GdprPage.fixtures';

let mockRoles = ['super-admin', 'operator', 'viewer'];
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => mockRoles.includes(role),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const ERASE_URL = `/api/v1/identity/${ADA_ID}/gdpr-erase`;
const TITLE = `Erase ${ADA_LABEL}?`;

type User = ReturnType<typeof userEvent.setup>;

/** Picks Ada and opens the erasure; resolves with the modal once the preview is shown. */
async function openErasure(user: User): Promise<HTMLElement> {
  await pickPerson(user, 'Ada');
  await user.click(await screen.findByRole('button', { name: /Erase personal data/ }));
  return modalTitled(TITLE);
}

/** The count a row of the deleted table shows. */
const countOf = (modal: HTMLElement, label: string) =>
  within(modal).getByText(label).closest('tr')?.querySelector('td')?.textContent;

describe('GdprPage erasure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ['super-admin', 'operator', 'viewer'];
  });

  it(
    'previews once on opening: what is deleted with the counts, and what stays',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      const modal = await openErasure(user);

      expect(await within(modal).findByText('This cannot be undone.')).toBeInTheDocument();
      // One dry run, without the confirmation header: nothing deleted.
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith(ERASE_URL, { params: { dryRun: 'true' } });

      expect(countOf(modal, 'Timeline events')).toBe('42');
      expect(countOf(modal, 'Access review items')).toBe('3');
      expect(countOf(modal, 'Access review exclusions (with reviewer and reason)')).toBe('0');
      expect(within(modal).getByText(/only published ones are deleted/i)).toBeInTheDocument();
      expect(
        within(modal).getByText('Erasure and dry-run entries are kept and not counted.'),
      ).toBeInTheDocument();
      // Deleted since the erasure reaches every record of the person (hunt 06 F4, r2-06 N1)
      expect(countOf(modal, 'Consent records')).toBe('3');
      expect(countOf(modal, 'Non-human identities the person owns')).toMatch(/^1Kept/);
      expect(within(modal).getByText(/the owner email is removed/)).toBeInTheDocument();
      expect(countOf(modal, 'Access graph node (Neo4j)')).toBe('1');
      expect(countOf(modal, 'Audit search index entries (Elasticsearch)')).toMatch(/^12Erasure/);
      expect(countOf(modal, 'Anomalies')).toBe('0');
      // Kept: the erasure's own audit entry under the id, other people's records, the accounts.
      expect(within(modal).getByText(/The audit entry of this erasure/)).toHaveTextContent(ADA_ID);
      expect(within(modal).queryByText(/consent records of the person/)).toBeNull();
      // HX-G follow-up: the person's linked admin identities are erased with them, each listed
      // with its tier and what is deleted of it; the Kept list no longer tells to erase each one.
      expect(within(modal).queryByText(/Linked admin accounts: each is an identity/)).toBeNull();
      const admins = within(modal).getByRole('list', { name: 'Linked admin identities' });
      expect(admins).toHaveTextContent(ADA_ADMIN_ID);
      expect(admins).toHaveTextContent('TIER_0: 6 records');
      expect(within(modal).getByText(/Accounts in connected systems/)).toBeInTheDocument();
      expect(within(modal).queryByText(/Not reached/)).toBeNull();
      expect(within(modal).getByText(/EuroID has no legal hold/)).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: /Erase permanently/ })).toBeDisabled();
    },
  );

  it(
    'erases only once the email is typed exactly, with the confirmation header, then shows the attestation',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      const modal = await openErasure(user);
      const erase = await within(modal).findByRole('button', { name: /Erase permanently/ });
      expect(within(modal).getByText(ADA_EMAIL, { selector: 'code' })).toBeInTheDocument();

      const input = within(modal).getByLabelText('Identifier to confirm');
      await user.click(input);
      await user.paste('ada.virtanen@corp');
      expect(erase).toBeDisabled();
      await user.paste('.example');
      expect(erase).toBeEnabled();
      const listBefore = loads(IDENTITY_LIST);

      await user.click(erase);

      await waitFor(() =>
        expect(mockDelete).toHaveBeenLastCalledWith(ERASE_URL, {
          headers: { 'X-Confirm-Erasure': 'true' },
        }),
      );
      const done = await modalTitled('Erasure done');
      expect(within(done).getByText('Personal data erased')).toBeInTheDocument();
      expect(within(done).getByText(/by dpo@corp\.example/)).toBeInTheDocument();
      expect(countOf(done, 'Timeline events')).toBe('42');
      expect(within(done).getByText(/keep a copy with the request/)).toBeInTheDocument();
      // The person is gone: the identity list reloads.
      await expectReloaded(IDENTITY_LIST, listBefore);

      await user.click(within(done).getByRole('button', { name: 'Done' }));
      // The picked person is cleared.
      expect(await screen.findByText('Pick a person')).toBeInTheDocument();
      expect(screen.queryByText('Erasure (Article 17)')).toBeNull();
    },
  );

  it(
    'shows the API message when the preview is refused, and retries',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      mockDelete.mockRejectedValueOnce(apiError(404, `Identity ${ADA_ID} not found`));
      renderWithProviders(<GdprPage />);
      const modal = await openErasure(user);

      expect(
        await within(modal).findByText(`Preview failed: Identity ${ADA_ID} not found`),
      ).toBeInTheDocument();
      expect(within(modal).getByRole('button', { name: /Erase permanently/ })).toBeDisabled();
      await user.click(within(modal).getByRole('button', { name: 'Retry' }));
      expect(await within(modal).findByText('This cannot be undone.')).toBeInTheDocument();
      expect(mockDelete).toHaveBeenCalledTimes(2);
    },
  );

  it(
    'shows the API message when the erasure is refused, and keeps the modal open',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      const served = mockDelete.getMockImplementation()!;
      mockDelete.mockImplementation((url: string, config?: { params?: Record<string, string> }) =>
        config?.params?.dryRun === 'true'
          ? served(url, config)
          : Promise.reject(apiError(403, 'GDPR erasure requires X-Confirm-Erasure: true header')),
      );
      renderWithProviders(<GdprPage />);
      const modal = await openErasure(user);
      const erase = await within(modal).findByRole('button', { name: /Erase permanently/ });
      await user.click(within(modal).getByLabelText('Identifier to confirm'));
      await user.paste(ADA_EMAIL);

      await user.click(erase);

      expect(
        await within(modal).findByText(
          'Erasure failed: GDPR erasure requires X-Confirm-Erasure: true header',
        ),
      ).toBeInTheDocument();
      expect(within(modal).getByText(/do not run in one transaction/)).toBeInTheDocument();
      expect(screen.queryByText('Erasure done')).toBeNull();
    },
  );

  it(
    'names a store the erasure could not reach, with what to do about it',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      mockDelete.mockImplementation((_url: string, config?: { params?: Record<string, string> }) =>
        Promise.resolve({
          data:
            config?.params?.dryRun === 'true'
              ? { ...preview, notReached: ['elasticsearch_audit_events'] }
              : { ...attestation, notReached: ['access_graph'] },
        }),
      );
      renderWithProviders(<GdprPage />);
      const modal = await openErasure(user);
      expect(
        await within(modal).findByText(/Audit search index \(Elasticsearch\): rebuild/),
      ).toBeInTheDocument();
      await user.click(within(modal).getByLabelText('Identifier to confirm'));
      await user.paste(ADA_EMAIL);

      await user.click(within(modal).getByRole('button', { name: /Erase permanently/ }));

      const done = await modalTitled('Erasure done');
      expect(
        within(done).getByText('Not reached: these may still hold the person'),
      ).toBeInTheDocument();
      expect(within(done).getByText(/runs Resync on the Access explorer page/)).toBeInTheDocument();
    },
  );

  it('closes without erasing on Cancel', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<GdprPage />);
    const modal = await openErasure(user);
    await within(modal).findByText('This cannot be undone.');

    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(mockDelete).toHaveBeenCalledTimes(1);
    // The person stays picked.
    expect(screen.getByText('Erasure (Article 17)')).toBeInTheDocument();
  });
});
