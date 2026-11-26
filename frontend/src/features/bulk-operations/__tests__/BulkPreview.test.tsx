import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkPreview } from '../BulkPreview';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

const parsedCsv = {
  headers: ['firstName', 'lastName', 'email', 'sourceSystem', 'sourceUserId'],
  rows: [
    ['Ada', 'Lovelace', 'ada@example.com', 'csv', 'u1'],
    ['Grace', '', 'grace@example.com', 'csv', 'u2'],
  ],
  raw: '',
};
const mapping = Object.fromEntries(parsedCsv.headers.map((h) => [h, h]));

const renderPreview = (onExecute: () => Promise<void>) =>
  render(
    <BulkPreview
      parsedCsv={parsedCsv}
      mapping={mapping}
      operationType="CREATE"
      targetSystems={['Microsoft Entra ID']}
      dryRun={false}
      continueOnError
      batchSize={10}
      requireApprovalForDeletes
      onDryRunChange={vi.fn()}
      onContinueOnErrorChange={vi.fn()}
      onBatchSizeChange={vi.fn()}
      onRequireApprovalChange={vi.fn()}
      onExecute={onExecute}
    />,
  );

// Hunt 2026-11-25 08 F4: Execute stayed clickable while the start request ran, and each click
// started its own workflow
describe('BulkPreview Execute', () => {
  it('starts the batch once however often it is clicked while the start is pending', async () => {
    let finish: () => void = () => undefined;
    const onExecute = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderPreview(onExecute);

    const execute = screen.getByRole('button', { name: /execute/i });
    fireEvent.click(execute);
    fireEvent.click(execute);
    fireEvent.click(execute);

    expect(onExecute).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /execute/i })).toBeDisabled());
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: /execute/i })).toBeEnabled());
  });

  // Hunt 2026-11-25 08 F9: a row missing a required field was dropped without a word
  it('says how many rows it leaves out for a missing required field', () => {
    renderPreview(vi.fn().mockResolvedValue(undefined));

    expect(screen.getByText(/1 row left out: a required field is empty/)).toBeInTheDocument();
  });
});
