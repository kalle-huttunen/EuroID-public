/**
 * Accepting a policy suggestion asks for confirmation first and only then accepts it. The
 * confirmation used the static Modal.confirm, which renders nothing under React 19, so a
 * suggestion could not be accepted from the page (2.0dh). Accept and Dismiss address the
 * suggestion by its `suggestionId`, the id the API routes take; after Accept the page goes to
 * the policies list when the answer names the draft policy it created (`resultingPolicyId`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message } from 'antd';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { PolicySuggestions } from '../PolicySuggestions';
import {
  acceptSuggestion,
  dismissSuggestion,
  fetchPolicySuggestions,
  type PolicySuggestion,
} from '@api/intelligence-api';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

const SUGGESTION_ID = '5f0c6a1e-3b7d-4c2a-9e8f-1a2b3c4d5e6f';
const suggestion: PolicySuggestion = {
  _id: '64b7f0c2a1b2c3d4e5f60a00',
  suggestionId: SUGGESTION_ID,
  type: 'BIRTHRIGHT_PATTERN',
  confidence: 92,
  title: 'Engineering gets GitHub',
  description: 'Most engineers hold the GitHub org membership.',
  status: 'pending',
};

vi.mock('@api/intelligence-api', () => ({
  fetchPolicySuggestions: vi.fn(),
  acceptSuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  intelligenceKeys: {
    suggestions: (params?: object) => ['intelligence', 'suggestions', params],
    suggestionsPrefix: () => ['intelligence', 'suggestions'],
  },
}));

vi.mock('@api/realtime', () => ({
  useSocket: vi.fn().mockReturnValue({ socket: null, status: 'disconnected' }),
}));

describe('PolicySuggestions', () => {
  beforeEach(() => {
    vi.mocked(fetchPolicySuggestions)
      .mockReset()
      .mockResolvedValue({
        data: [suggestion],
        total: 1,
      });
    vi.mocked(acceptSuggestion).mockReset().mockResolvedValue(suggestion);
    vi.mocked(dismissSuggestion).mockReset().mockResolvedValue(suggestion);
    mockNavigate.mockReset();
  });

  async function acceptViaConfirmation(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /Accept & Create Draft$/ }));
    const dialog = (
      await screen.findByText('Accept & Create Draft Policy?', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));
  }

  it('accepts a suggestion once its confirmation is accepted', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PolicySuggestions />);

    await user.click(await screen.findByRole('button', { name: /Accept & Create Draft$/ }));
    // antd also puts the confirm's title in a hidden modal title; match the visible one.
    const dialog = (
      await screen.findByText('Accept & Create Draft Policy?', {
        selector: '.ant-modal-confirm-title',
      })
    ).closest('.ant-modal') as HTMLElement;
    expect(acceptSuggestion).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(acceptSuggestion).toHaveBeenCalledTimes(1));
    // The mutation also hands TanStack's context as a second argument; the id is the first.
    expect(vi.mocked(acceptSuggestion).mock.calls[0][0]).toBe(SUGGESTION_ID);
  });

  it(
    'goes to Role-based rules, where the draft is listed, once the answer names the policy',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      vi.mocked(acceptSuggestion).mockResolvedValue({
        ...suggestion,
        status: 'accepted',
        resultingPolicyId: '665f1c2a1b2c3d4e5f60aaaa',
      });
      renderWithProviders(<PolicySuggestions />);

      await acceptViaConfirmation(user);

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/role-rules'));
    },
  );

  it('stays on the page when the answer names no resulting policy', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PolicySuggestions />);

    await acceptViaConfirmation(user);

    await waitFor(() => expect(acceptSuggestion).toHaveBeenCalledTimes(1));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('dismisses the suggestion by its suggestionId with the reason given', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PolicySuggestions />);

    await user.click(await screen.findByRole('button', { name: /Dismiss$/ }));
    const dialog = (await screen.findByText('Dismiss suggestion')).closest(
      '.ant-modal',
    ) as HTMLElement;
    await user.type(within(dialog).getByPlaceholderText('Reason (optional)'), 'Not now');
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(dismissSuggestion).toHaveBeenCalledWith(SUGGESTION_ID, 'Not now'));
  });

  it('reloads the suggestions after a dismiss, so the card shows its new status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PolicySuggestions />);
    await waitFor(() => expect(fetchPolicySuggestions).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole('button', { name: /Dismiss$/ }));
    const dialog = (await screen.findByText('Dismiss suggestion')).closest(
      '.ant-modal',
    ) as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(dismissSuggestion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchPolicySuggestions).toHaveBeenCalledTimes(2));
  });

  it('shows the API reason when accepting fails', async () => {
    const user = userEvent.setup();
    const showError = vi.spyOn(message, 'error');
    vi.mocked(acceptSuggestion).mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: { message: `Suggestion ${SUGGESTION_ID} is not pending (status: accepted)` },
        },
      }),
    );
    renderWithProviders(<PolicySuggestions />);

    await acceptViaConfirmation(user);

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith(
        `Failed to accept: Suggestion ${SUGGESTION_ID} is not pending (status: accepted)`,
      ),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    showError.mockRestore();
  });
});

// 08 F7: a failed load showed "No suggestions yet".
describe('PolicySuggestions when the suggestions cannot be loaded', () => {
  it('says so instead of "No suggestions yet"', async () => {
    vi.mocked(fetchPolicySuggestions)
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('Request failed with status code 403'), {
          response: { status: 403, data: { message: 'Forbidden resource' } },
        }),
      );
    renderWithProviders(<PolicySuggestions />);

    expect(await screen.findByText('Suggestions could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/No suggestions yet/)).toBeNull();
  });
});

// 08 F8: Accept and Dismiss need policy-admin (policy-suggestions.controller.ts).
describe('PolicySuggestions role gate', () => {
  beforeEach(() => {
    vi.mocked(fetchPolicySuggestions)
      .mockReset()
      .mockResolvedValue({ data: [suggestion], total: 1 });
  });

  it('shows an operator the suggestion without Accept or Dismiss', async () => {
    renderWithProviders(<PolicySuggestions />, {
      authValue: {
        ...mockAuthValue,
        user: {
          ...mockAuthValue.user,
          profile: { ...mockAuthValue.user.profile, roles: ['operator'] },
        },
      },
    });

    expect(await screen.findByText('Engineering gets GitHub')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept & Create Draft/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
  });
});
