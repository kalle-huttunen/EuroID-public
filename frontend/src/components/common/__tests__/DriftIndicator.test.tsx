import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DriftIndicator } from '../DriftIndicator';

describe('DriftIndicator', () => {
  it('shows green checkmark when isSynced=true', () => {
    render(<DriftIndicator field="department" isSynced={true} />);
    expect(screen.getByRole('status', { name: 'In sync' })).toBeInTheDocument();
  });

  it('shows yellow warning when isSynced=false', () => {
    render(<DriftIndicator field="department" isSynced={false} />);
    expect(screen.getByRole('status', { name: 'Drift detected' })).toBeInTheDocument();
  });

  it('tooltip shows expected vs actual values when drifted', async () => {
    const user = userEvent.setup();
    render(
      <DriftIndicator
        field="department"
        isSynced={false}
        expectedValue="Engineering"
        actualValue="Sales"
        connector="Workday"
      />,
    );
    const indicator = screen.getByRole('status', { name: 'Drift detected' });
    // The tooltip opens on the warning icon inside the status element.
    await user.hover(indicator.querySelector('.anticon')!);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Hub says: Engineering');
    expect(tooltip).toHaveTextContent('Workday says: Sales');
  });
});
