/**
 * Authoritative attributes on the identity profile (owner decision 2026-11-24): a field an HR
 * source masters is read-only and names its owner, since the API refuses to change it and the
 * next HR sync would set it back. A department with an active override shows the override. Fields
 * EuroID keeps stay editable. The owners come from GET /identity/:id/mastery. An operator (the
 * controls route's role) sets, changes or removes the override of the department or job title
 * there, in a centered modal; a viewer gets no such action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Form } from 'antd';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { renderWithProviders } from '../../../../test/test-utils';
import { UserProfileTab } from '../UserProfileTab';
import type { IStandardUserWithMeta } from '../user-detail.types';

dayjs.extend(customParseFormat);

const ID = '64b7f0c2a1b2c3d4e5f60811';
/** The antd form renders slowly in jsdom: the owners arrive after its first render. */
const LOADED = { timeout: 10_000 };

const mockGet = vi.fn();
const mockPatch = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    post: vi.fn(),
  },
}));

// The controls route needs operator; a test sets a viewer
let mockCanOperate = true;
vi.mock('../../../../auth/usePermission', () => ({ usePermission: () => mockCanOperate }));

vi.mock('@api/reconciliation-api', () => ({
  fetchDrifts: vi.fn().mockResolvedValue([]),
  correctDrift: vi.fn(),
  reconciliationKeys: {
    drifts: (p?: object) => ['reconciliation', 'drifts', p],
    driftsPrefix: () => ['reconciliation', 'drifts'],
  },
}));

/** The response of GET /identity/:id/mastery as the API answers it. */
const mastery = {
  identityId: ID,
  masteredBy: { departmentName: 'csv-hr', jobTitle: 'csv-hr', firstName: 'csv-hr' },
  attributeControls: {
    departmentName: {
      value: 'R&D',
      reason: 'Reorg pilot',
      setBy: 'op@corp.example',
      setAt: '2026-11-24T08:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
    },
  },
};

const user = {
  _id: ID,
  email: 'maija.meikalainen@corp.example',
  firstName: 'Maija',
  lastName: 'Meikäläinen',
  departmentName: 'R&D',
  jobTitle: 'Analyst',
  status: 'ACTIVE',
} as unknown as IStandardUserWithMeta;

function ProfileTab() {
  const [form] = Form.useForm();
  return (
    <UserProfileTab
      user={user}
      form={form}
      identityId={ID}
      identityData={null}
      showSyncWarning={false}
      changedFields={[]}
      onFieldsChange={() => {}}
    />
  );
}

describe('UserProfileTab field mastery', () => {
  beforeEach(() => {
    mockCanOperate = true;
    mockPatch.mockReset().mockResolvedValue({ data: { success: true } });
    mockGet
      .mockReset()
      .mockImplementation((url: string) =>
        Promise.resolve({ data: url.endsWith(`/identity/${ID}/mastery`) ? mastery : {} }),
      );
  });

  it(
    'shows an HR-mastered field read-only with its owner, and an override with its reason',
    { timeout: 20_000 },
    async () => {
      renderWithProviders(<ProfileTab />);

      await waitFor(() => expect(screen.getByLabelText(/^Job Title/)).toBeDisabled(), LOADED);
      expect(mockGet).toHaveBeenCalledWith(`/api/v1/identity/${ID}/mastery`);
      expect(screen.getByLabelText(/^Department Name/)).toBeDisabled();
      expect(screen.getByLabelText(/^First Name/)).toBeDisabled();
      // The department's hint also shows its override, so it is matched from the start only
      expect(screen.getAllByText(/^Mastered by csv-hr: change it in HR\./)).toHaveLength(3);
      expect(
        screen.getByText(/Override in effect: R&D, until .* \(reason: Reorg pilot\)\.$/),
      ).toBeInTheDocument();
    },
  );

  it('keeps the fields EuroID keeps editable', { timeout: 20_000 }, async () => {
    renderWithProviders(<ProfileTab />);

    await waitFor(() => expect(screen.getByLabelText(/^Job Title/)).toBeDisabled(), LOADED);
    expect(screen.getByLabelText('Middle Name')).toBeEnabled();
    expect(screen.getByLabelText('Preferred Name')).toBeEnabled();
    expect(screen.getByLabelText(/^Last Name/)).toBeEnabled();
  });

  it('keeps every field editable while the owners are unknown', { timeout: 20_000 }, async () => {
    mockGet.mockReset().mockResolvedValue({ data: {} });
    renderWithProviders(<ProfileTab />);

    expect(await screen.findByLabelText(/^Department Name/, undefined, LOADED)).toBeEnabled();
    expect(screen.queryByText(/Mastered by/)).toBeNull();
  });

  describe('override of the department or job title', () => {
    const noOverride = { ...mastery, attributeControls: {} };
    const serve = (answer: typeof mastery | typeof noOverride) =>
      mockGet
        .mockReset()
        .mockImplementation((url: string) =>
          Promise.resolve({ data: url.endsWith(`/identity/${ID}/mastery`) ? answer : {} }),
        );
    /** The open modal, found by its title. */
    const modal = async (title: string) =>
      (await screen.findByText(title, { selector: '.ant-modal-title' }, LOADED)).closest(
        '.ant-modal',
      ) as HTMLElement;

    it(
      'sets an override with a value and a reason through the controls route',
      { timeout: 20_000 },
      async () => {
        serve(noOverride);
        const u = userEvent.setup();
        renderWithProviders(<ProfileTab />);

        await u.click(
          await screen.findByRole('button', { name: 'Override the department' }, LOADED),
        );
        const dialog = await modal('Override the department');
        const set = within(dialog).getByRole('button', { name: 'Set override' });
        expect(set).toBeDisabled();
        await u.type(within(dialog).getByLabelText('New department'), 'R&D');
        await u.type(within(dialog).getByLabelText('Reason'), 'Reorg pilot');
        await u.click(set);

        await waitFor(() =>
          expect(mockPatch).toHaveBeenCalledWith(`/api/v1/identity/v2/${ID}/controls`, {
            manualDepartment: 'R&D',
            reason: 'Reorg pilot',
          }),
        );
        expect(
          await screen.findByText('Override set: the department is R&D until it is removed'),
        ).toBeInTheDocument();
      },
    );

    // The expiry picker has a time, and its onChange fired only on [OK]: a date picked without
    // [OK] showed in the field, but the override was sent without expiresAt and never expired
    // (browser check 2026-11-25). The value the field shows is the value sent.
    it(
      'sends the expiry the field shows, also when the date was picked without [OK]',
      { timeout: 20_000 },
      async () => {
        serve(noOverride);
        const u = userEvent.setup();
        renderWithProviders(<ProfileTab />);

        await u.click(
          await screen.findByRole('button', { name: 'Override the department' }, LOADED),
        );
        const dialog = await modal('Override the department');
        await u.type(within(dialog).getByLabelText('New department'), 'R&D');
        await u.type(within(dialog).getByLabelText('Reason'), 'Reorg pilot');
        const expires = within(dialog).getByLabelText('Expires (optional)');
        await u.click(expires);
        const day = dayjs().add(1, 'month').startOf('month').add(14, 'day');
        // The next month, then its 15th; no [OK]
        await u.click(await screen.findByRole('button', { name: 'Next month (PageDown)' }));
        await u.click(
          document.querySelector(
            `.ant-picker-cell-in-view[title="${day.format('YYYY-MM-DD')}"]`,
          ) as HTMLElement,
        );
        const shown = (expires as HTMLInputElement).value;
        expect(shown).toMatch(new RegExp(`^${day.format('YYYY-MM-DD')} \\d{2}:\\d{2}$`));

        await u.click(within(dialog).getByRole('button', { name: 'Set override' }));

        await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
        expect(mockPatch).toHaveBeenCalledWith(`/api/v1/identity/v2/${ID}/controls`, {
          manualDepartment: 'R&D',
          reason: 'Reorg pilot',
          expiresAt: dayjs(shown, 'YYYY-MM-DD HH:mm').toISOString(),
        });
        expect(
          await screen.findByText(
            'Override set: the department is R&D until it is removed or expires',
          ),
        ).toBeInTheDocument();
      },
    );

    it('removes the active override, with the optional reason', { timeout: 20_000 }, async () => {
      serve(mastery);
      const u = userEvent.setup();
      renderWithProviders(<ProfileTab />);

      await u.click(
        await screen.findByRole('button', { name: 'Remove the department override' }, LOADED),
      );
      const dialog = await modal('Remove the department override');
      await u.type(within(dialog).getByLabelText('Reason (optional)'), 'Pilot over');
      await u.click(within(dialog).getByRole('button', { name: 'Remove override' }));

      await waitFor(() =>
        expect(mockPatch).toHaveBeenCalledWith(`/api/v1/identity/v2/${ID}/controls`, {
          manualDepartment: '',
          reason: 'Pilot over',
        }),
      );
      expect(
        await screen.findByText('Override removed: the department follows csv-hr again'),
      ).toBeInTheDocument();
    });

    it(
      "shows the API's message when the override is refused, and keeps the modal open",
      { timeout: 20_000 },
      async () => {
        serve(noOverride);
        mockPatch.mockRejectedValue(
          Object.assign(new Error('Request failed with status code 400'), {
            response: {
              status: 400,
              data: { message: ['expiresAt: expiresAt must be in the future'] },
            },
          }),
        );
        const u = userEvent.setup();
        renderWithProviders(<ProfileTab />);

        await u.click(
          await screen.findByRole('button', { name: 'Override the job title' }, LOADED),
        );
        const dialog = await modal('Override the job title');
        await u.type(within(dialog).getByLabelText('New job title'), 'Interim lead');
        await u.type(within(dialog).getByLabelText('Reason'), 'Covering a leave');
        await u.click(within(dialog).getByRole('button', { name: 'Set override' }));

        expect(
          await screen.findByText('Not saved: expiresAt: expiresAt must be in the future'),
        ).toBeInTheDocument();
        expect(within(dialog).getByLabelText('New job title')).toHaveValue('Interim lead');
      },
    );

    it('offers a viewer no override, only the owner', { timeout: 20_000 }, async () => {
      mockCanOperate = false;
      serve(mastery);
      renderWithProviders(<ProfileTab />);

      await waitFor(() => expect(screen.getByLabelText(/^Department Name/)).toBeDisabled(), LOADED);
      expect(screen.getAllByText(/^Mastered by csv-hr: change it in HR\./)).toHaveLength(3);
      expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
    });
  });
});
