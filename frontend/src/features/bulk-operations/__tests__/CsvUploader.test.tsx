import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider, App as AntdApp } from 'antd';
import { CsvUploader } from '../CsvUploader';
import type { ParsedCsv } from '../CsvUploader';
import * as csvUtils from '../csv-utils';

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

function ControlledCsvUploader() {
  const [value, setValue] = useState<ParsedCsv | null>(null);
  return <CsvUploader value={value} onChange={setValue} />;
}

describe('CsvUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders upload area', () => {
    const onChange = vi.fn();
    render(
      <TestWrapper>
        <CsvUploader value={null} onChange={onChange} />
      </TestWrapper>,
    );
    expect(screen.getByText(/click or drag a csv file here/i)).toBeInTheDocument();
    expect(screen.getByText(/only \.csv files/i)).toBeInTheDocument();
  });

  it('rejects non-CSV file types', async () => {
    // The input's accept=".csv" filters the file picker only; a dropped file reaches the check.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => consoleError.mockRestore());
    const onChange = vi.fn();
    const { container } = render(
      <TestWrapper>
        <CsvUploader value={null} onChange={onChange} />
      </TestWrapper>,
    );
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeInTheDocument();
    const file = new File(['name,email\nAlice,alice@example.com'], 'test.txt', {
      type: 'text/plain',
    });
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input!, file);
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Only CSV files are allowed' }),
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('parses valid CSV and displays preview', async () => {
    const csvContent = 'name,email\nAlice,alice@example.com\nBob,bob@example.com';
    const { container } = render(
      <TestWrapper>
        <ControlledCsvUploader />
      </TestWrapper>,
    );
    const input = container.querySelector('input[type="file"]');
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const user = userEvent.setup();
    await user.upload(input!, file);
    await waitFor(() => {
      expect(screen.getByText(/detected 2 columns, 2 data rows/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('does not show preview when parseCsv throws', async () => {
    vi.spyOn(csvUtils, 'parseCsv').mockImplementation(() => {
      throw new Error('Invalid CSV');
    });
    const onChange = vi.fn();
    const { container } = render(
      <TestWrapper>
        <CsvUploader value={null} onChange={onChange} />
      </TestWrapper>,
    );
    const input = container.querySelector('input[type="file"]');
    const file = new File(['a,b\n"unclosed'], 'bad.csv', { type: 'text/csv' });
    const user = userEvent.setup();
    await user.upload(input!, file);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/detected \d+ columns/i)).not.toBeInTheDocument();
  });
});
