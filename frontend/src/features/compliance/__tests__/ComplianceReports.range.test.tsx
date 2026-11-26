/**
 * r2-08 N9: the report range went out as the picked moments, so a range picked in the calendar
 * (midnight, or the time of day of the default) left out part of the last day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import ComplianceReports from '../ComplianceReports';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue({ data: [] });
  mockPost.mockReset().mockResolvedValue({
    data: { summary: { complianceScore: 90, criticalFindings: 0 } },
  });
});

describe('ComplianceReports date range', () => {
  it('asks for whole days: from the first day at 00:00 to the last day at 23:59:59.999', async () => {
    renderWithProviders(<ComplianceReports />);

    await userEvent.click(await screen.findByRole('button', { name: /Generate/ }));

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const { from, to } = mockPost.mock.calls[0][1].dateRange;
    expect(dayjs(from).format('HH:mm:ss.SSS')).toBe('00:00:00.000');
    expect(dayjs(to).format('YYYY-MM-DD HH:mm:ss.SSS')).toBe(
      `${dayjs().format('YYYY-MM-DD')} 23:59:59.999`,
    );
  });
});
