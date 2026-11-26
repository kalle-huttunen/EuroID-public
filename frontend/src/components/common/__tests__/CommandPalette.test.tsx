/**
 * 08 F6: a person picked in the command palette opened /users?highlight=<id>, a parameter nothing
 * reads, so the user landed on page 1 of the Identity hub. And the debounced search had no stale
 * guard: a slow answer to an older query replaced the results of the newer one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../../test/test-utils';
import { CommandPalette } from '../CommandPalette';
import { useCommandPaletteStore } from '@stores/command-palette-store';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args) },
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

/** Identity searches sent, by query, with the function that answers each. */
const searches = new Map<string, (rows: unknown[]) => void>();

beforeEach(() => {
  searches.clear();
  // cmdk scrolls the selected item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  mockGet.mockImplementation((url: string, config?: { params?: { q?: string } }) => {
    if (url.endsWith('/identity') && config?.params?.q) {
      return new Promise((resolve) =>
        searches.set(config.params!.q!, (rows) => resolve({ data: rows })),
      );
    }
    return Promise.resolve({ data: {} });
  });
  act(() => useCommandPaletteStore.getState().setOpen(true));
});

afterEach(() => {
  act(() => useCommandPaletteStore.getState().setOpen(false));
});

describe('CommandPalette identity search', () => {
  it("opens the chosen person's identity page", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <CommandPalette />
        <Where />
      </>,
    );

    await user.type(screen.getByPlaceholderText(/Search identities/), 'Riikka');
    await waitFor(() => expect(searches.has('Riikka')).toBe(true));
    act(() =>
      searches.get('Riikka')!([
        { _id: '65f0c1a2b3c4d5e6f7a8b9c0', displayName: 'Riikka Tuominen', email: 'r@x.example' },
      ]),
    );
    await user.click(await screen.findByText('Riikka Tuominen'));

    expect(screen.getByTestId('where')).toHaveTextContent('/identities/65f0c1a2b3c4d5e6f7a8b9c0');
  });

  it('keeps the newer query results when an older answer comes late', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette />);
    const input = screen.getByPlaceholderText(/Search identities/);

    await user.type(input, 'ri');
    await waitFor(() => expect(searches.has('ri')).toBe(true));
    await user.type(input, 'ikka');
    await waitFor(() => expect(searches.has('riikka')).toBe(true));

    act(() => searches.get('riikka')!([{ _id: 'a1', displayName: 'Riikka Tuominen' }]));
    expect(await screen.findByText('Riikka Tuominen')).toBeInTheDocument();
    act(() => searches.get('ri')!([{ _id: 'b2', displayName: 'Rita Virtanen' }]));

    await act(async () => {});
    expect(screen.queryByText('Rita Virtanen')).toBeNull();
    expect(screen.getByText('Riikka Tuominen')).toBeInTheDocument();
  });
});
