/**
 * The registry table's column budget. With a fixed layout the columns with a width keep it and
 * the Agent column, which has none, gets what the table width leaves. The other columns took
 * 1066 px of the 1080 px minimum, so at 1440 px the Agent column was about 50 px wide and names
 * and ids wrapped letter by letter (browser check 2026-11-25, round1125-P1-nhi-01).
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { AgentTable } from '../AgentTable';
import { AGENTS } from './NhiPage.fixtures';

/** Room the Agent column needs: a display name, an id in code font, "Delegated from <id>". */
const AGENT_MIN_PX = 200;
/**
 * The table's width at a 1440 px window: 240 px side menu, 24 px page padding on each side and
 * the card's 16 px padding and border on each side leave about 1118 px; a few px less with a
 * classic scrollbar. Up to this the table needs no sideways scroll.
 */
const CONTENT_PX_AT_1440 = 1100;

function columnBudget() {
  const table = screen.getByRole('table', { name: 'Non-human identities' });
  const minWidth = parseInt(table.style.width || table.style.minWidth, 10);
  const widths = Array.from(table.querySelectorAll('colgroup col')).map((col) =>
    parseInt((col as HTMLElement).style.width, 10),
  );
  return { minWidth, widths };
}

describe('AgentTable layout', () => {
  it('leaves the Agent column room for names at its narrowest, and fits a 1440 px window', () => {
    renderWithProviders(
      <AgentTable
        rows={AGENTS}
        total={AGENTS.length}
        page={1}
        pageSize={50}
        onPage={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    const { minWidth, widths } = columnBudget();
    // The Agent column is the only one without a width; it takes what the others leave
    expect(widths.filter(Number.isNaN)).toHaveLength(1);
    expect(Number.isNaN(widths[0])).toBe(true);
    const others = widths.filter((w) => !Number.isNaN(w)).reduce((sum, w) => sum + w, 0);
    expect(minWidth - others).toBeGreaterThanOrEqual(AGENT_MIN_PX);
    // Narrower windows (phones) scroll inside the card; 1440 px does not
    expect(minWidth).toBeLessThanOrEqual(CONTENT_PX_AT_1440);
  });
});
