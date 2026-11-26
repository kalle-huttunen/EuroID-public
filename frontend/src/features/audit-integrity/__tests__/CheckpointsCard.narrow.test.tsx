/**
 * The Merkle checkpoints card at phone width. Its two buttons sat in the card header next to the
 * title, which the header squeezed to "M" at 400 px (browser check 2026-11-25,
 * round1125-P1-au-18 at 400). Below 576 px they move to the top of the card body; wider, they
 * stay in the header.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { CheckpointsCard } from '../CheckpointsCard';
import { mockGet, mockPost, serve, signed } from './AuditIntegrityPage.fixtures';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const originalMatchMedia = window.matchMedia;

/** A window this many px wide: min-width and max-width media queries answer as a browser's. */
function windowWidth(px: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || px >= Number(min[1])) && (!max || px <= Number(max[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

async function renderCard() {
  renderWithProviders(<CheckpointsCard onOpenAnchor={vi.fn()} />);
  const card = screen.getByRole('region', { name: 'Merkle checkpoints' });
  await within(card).findByText('1025 to 1152');
  return {
    head: card.querySelector('.ant-card-head') as HTMLElement,
    body: card.querySelector('.ant-card-body') as HTMLElement,
  };
}

const BUTTONS = [/Create checkpoint/, /Check checkpoints/];

describe('CheckpointsCard header by window width', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve({ checkpoints: [signed] });
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('at 400 px keeps the header for the title and puts the buttons in the body', async () => {
    windowWidth(400);
    const { head, body } = await renderCard();

    expect(within(head).getByText('Merkle checkpoints')).toBeInTheDocument();
    expect(within(head).queryAllByRole('button')).toHaveLength(0);
    for (const name of BUTTONS) {
      expect(within(body).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('at 1440 px keeps the buttons in the header', async () => {
    windowWidth(1440);
    const { head, body } = await renderCard();

    for (const name of BUTTONS) {
      expect(within(head).getByRole('button', { name })).toBeInTheDocument();
      expect(within(body).queryByRole('button', { name })).toBeNull();
    }
  });
});
