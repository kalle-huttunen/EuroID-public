/**
 * r2-08 N1 and N2: the New hire wizard required a role bundle and said "N actions will be
 * applied", but the request carries no bundle: access comes from the active role-based rules the
 * person matches (a bundle only through a rule that uses it). With no bundles, or a failed bundle
 * load, Next stayed disabled and no hire could be started.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { OnboardingWizard } from '../OnboardingWizard';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const bundle = {
  id: 'b1',
  name: 'Finance bundle',
  description: 'Finance access',
  icon: 'UserOutlined',
  color: 'blue',
  actions: [{ id: 'a1', type: 'ADD_TO_GROUP', target: 'entra-id', params: {} }],
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset().mockResolvedValue({
    data: { workflow: { triggered: true, workflowId: 't-default-onboarding-1' } },
  });
});

async function fillDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Jane'), 'Riikka');
  await user.type(screen.getByPlaceholderText('Doe'), 'Tuominen');
  await user.type(screen.getByPlaceholderText('jane.doe@company.com'), 'riikka@corp.example');
}

describe('OnboardingWizard', { timeout: 20_000 }, () => {
  it('starts a hire in a tenant with no role bundles', async () => {
    mockGet.mockResolvedValue({ data: [], headers: {} });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard open onClose={vi.fn()} onComplete={onComplete} />);

    await screen.findByText('No role bundles yet.');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fillDetails(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: /Start Onboarding/ }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('t-default-onboarding-1'));
  });

  it('does not claim the chosen bundle is applied', async () => {
    mockGet.mockResolvedValue({ data: [bundle], headers: {} });
    const user = userEvent.setup();
    renderWithProviders(<OnboardingWizard open onClose={vi.fn()} onComplete={vi.fn()} />);

    await user.click(await screen.findByText('Finance bundle'));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await fillDetails(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.queryByText(/will be applied/)).toBeNull();
    expect(screen.getByText(/role-based rules the person matches/)).toBeInTheDocument();
  });
});
