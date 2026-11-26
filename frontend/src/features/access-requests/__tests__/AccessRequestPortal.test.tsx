import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { AccessRequestPortal } from '../AccessRequestPortal';

// Mock sub-components
vi.mock('../EntitlementBrowser', () => ({
  EntitlementBrowser: () => <div data-testid="entitlement-browser">EntitlementBrowser</div>,
}));

vi.mock('../MyRequests', () => ({
  MyRequests: () => <div data-testid="my-requests">MyRequests</div>,
}));

vi.mock('../ApprovalQueue', () => ({
  ApprovalQueue: () => <div data-testid="approval-queue">ApprovalQueue</div>,
}));

vi.mock('../RemovalFailing', () => ({
  RemovalFailing: () => <div data-testid="removal-failing">RemovalFailing</div>,
}));

let isPolicyAdmin = false;
vi.mock('../../../auth/usePermission', () => ({ usePermission: () => isPolicyAdmin }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
  },
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAt(route: string) {
  renderWithProviders(
    <>
      <AccessRequestPortal />
      <LocationProbe />
    </>,
    { initialRoute: route },
  );
}

const selectedTab = () => screen.getByRole('tab', { selected: true });

describe('AccessRequestPortal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPolicyAdmin = false;
  });

  it('opens the tab the route names and puts a chosen tab in the route', async () => {
    // The navigation links /access-requests/approvals; a request links ?tab=my-requests.
    const user = userEvent.setup();
    renderAt('/access-requests/approvals');
    expect(selectedTab()).toHaveTextContent('Pending approvals');
    expect(screen.getByTestId('approval-queue')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /My requests/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(
      /^\/access-requests\?tab=my-requests$/,
    );
    expect(selectedTab()).toHaveTextContent('My requests');
    expect(screen.getByTestId('my-requests')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Browse catalog/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/access-requests$/);
    expect(selectedTab()).toHaveTextContent('Browse catalog');
  });

  it('opens My requests from ?tab=my-requests', () => {
    renderAt('/access-requests?tab=my-requests');
    expect(selectedTab()).toHaveTextContent('My requests');
  });

  it('opens the catalog for any other route', () => {
    renderAt('/access-requests?tab=unknown');
    expect(selectedTab()).toHaveTextContent('Browse catalog');
    expect(screen.getByTestId('entitlement-browser')).toBeInTheDocument();
  });

  // HX-E4: no admin view listed the requests whose removal keeps failing
  it('offers a policy-admin the failing removals at ?tab=removal-failing', async () => {
    isPolicyAdmin = true;
    renderAt('/access-requests?tab=removal-failing');

    expect(selectedTab()).toHaveTextContent('Removal failing');
    expect(screen.getByTestId('removal-failing')).toBeInTheDocument();
  });

  it('shows no such tab to anyone else, and opens the catalog for its route', () => {
    renderAt('/access-requests?tab=removal-failing');

    expect(screen.queryByRole('tab', { name: /Removal failing/ })).not.toBeInTheDocument();
    expect(selectedTab()).toHaveTextContent('Browse catalog');
  });
});
