/**
 * r2-08 N5: with the relative API_BASE every deployment uses (/api/v1), new URL(API_BASE) threw
 * and the page showed the placeholder https://your-euroid-domain/scim/v2/ to copy into the IdP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { SCIMSettings } from '../SCIMSettings';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ data: [] });
});

describe('SCIMSettings', { timeout: 20_000 }, () => {
  it("shows the console's own origin as the SCIM base URL", async () => {
    renderWithProviders(<SCIMSettings />);

    expect(await screen.findByText(`${window.location.origin}/scim/v2/`)).toBeInTheDocument();
    expect(screen.queryByText(/your-euroid-domain/)).toBeNull();
  });
});
