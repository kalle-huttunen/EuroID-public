/**
 * 09 F5: the audit CSV quoted cells and doubled quotes only, so a value starting with = + - @
 * (from an HR feed or a display name) ran as a formula in Excel or Sheets; and it exported only
 * the page on screen. 09 F9: a date-only range went out at the picked moment's time of day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';
import { csvCell, eventsToCSV, wholeDays } from '../audit-export';
import { fetchAuditEventsForExport } from '@api/audit-api';
import type { IAuditEvent } from '../../../interfaces';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({ axiosInstance: { get: (...args: unknown[]) => mockGet(...args) } }));

describe('audit CSV', () => {
  it.each(['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralises a cell starting with a formula character: %s',
    (value) => {
      const cell = csvCell(value);
      expect(cell.startsWith(`"'`)).toBe(true);
    },
  );

  it('quotes every cell and doubles the quotes inside', () => {
    expect(csvCell('Riikka "Rii" Tuominen')).toBe('"Riikka ""Rii"" Tuominen"');
    expect(csvCell(undefined)).toBe('""');
  });

  it('writes the action and the description through the same rule', () => {
    const csv = eventsToCSV([
      {
        timestamp: '2026-11-25T10:00:00.000Z',
        action: 'USER_UPDATED',
        actor: 'hr-feed',
        resourceName: "=cmd|' /C calc'!A0",
        targetSystem: 'entra-id',
        description: '@evil',
      } as unknown as IAuditEvent,
    ]);
    const row = csv.split('\n')[1];
    expect(row).toContain(`"'=cmd|' /C calc'!A0"`);
    expect(row).toContain(`"'@evil"`);
    expect(row).toContain('"USER_UPDATED"');
  });
});

describe('audit date range', () => {
  it('covers the whole first and last day', () => {
    const [from, to] = wholeDays([dayjs('2026-11-20T15:42:00'), dayjs('2026-11-22T09:10:00')]);
    expect(dayjs(from).format('YYYY-MM-DD HH:mm:ss.SSS')).toBe('2026-11-20 00:00:00.000');
    expect(dayjs(to).format('YYYY-MM-DD HH:mm:ss.SSS')).toBe('2026-11-22 23:59:59.999');
  });

  it('leaves an open end open', () => {
    expect(wholeDays([null, null])).toEqual([undefined, undefined]);
  });
});

describe('fetchAuditEventsForExport', () => {
  beforeEach(() => mockGet.mockReset());

  it('reads every page of the filtered log, 100 at a time', async () => {
    mockGet.mockImplementation(async (url: string) => {
      const page = Number(new URLSearchParams(String(url).split('?')[1]).get('page'));
      const count = page < 3 ? 100 : 30;
      return {
        data: {
          data: Array.from({ length: count }, (_, i) => ({ _id: `${page}-${i}`, action: 'X' })),
          total: 230,
        },
      };
    });

    const { events, total } = await fetchAuditEventsForExport({ search: 'riikka' }, 1000);

    expect(events).toHaveLength(230);
    expect(total).toBe(230);
    const urls = mockGet.mock.calls.map(([u]) => u as string);
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => u.includes('limit=100') && u.includes('search=riikka'))).toBe(true);
  });

  // Final review FE2: each GET /audit logs an event newer than everything in the list, so with an
  // open (or future) end every page request shifted the newest-first offset by one: a row
  // repeated at each page boundary and the oldest rows were cut
  describe('pins the end of the range for every page', () => {
    const NOW = new Date('2026-11-26T12:00:00.000Z');
    const dateToOfEachPage = () =>
      mockGet.mock.calls.map(([u]) => new URLSearchParams(String(u).split('?')[1]).get('dateTo'));

    beforeEach(() => {
      mockGet.mockImplementation(async (url: string) => {
        const page = Number(new URLSearchParams(String(url).split('?')[1]).get('page'));
        return {
          data: {
            data: Array.from({ length: page < 2 ? 100 : 10 }, (_, i) => ({ _id: `${page}-${i}` })),
            total: 110,
          },
        };
      });
    });

    it('to the export start when the filter has no end', async () => {
      await fetchAuditEventsForExport({}, 1000, NOW);

      expect(dateToOfEachPage()).toEqual([NOW.toISOString(), NOW.toISOString()]);
    });

    it('to the export start when the end is still to come (the end of today)', async () => {
      await fetchAuditEventsForExport({ dateTo: '2026-11-26T23:59:59.999Z' }, 1000, NOW);

      expect(dateToOfEachPage()).toEqual([NOW.toISOString(), NOW.toISOString()]);
    });

    it("to the filter's end when that is earlier", async () => {
      await fetchAuditEventsForExport({ dateTo: '2026-11-20T23:59:59.999Z' }, 1000, NOW);

      expect(dateToOfEachPage()).toEqual(['2026-11-20T23:59:59.999Z', '2026-11-20T23:59:59.999Z']);
    });
  });

  it('stops at the cap and reports the total', async () => {
    mockGet.mockResolvedValue({
      data: { data: Array.from({ length: 100 }, (_, i) => ({ _id: `${i}` })), total: 5000 },
    });

    const { events, total } = await fetchAuditEventsForExport({}, 200);

    expect(events).toHaveLength(200);
    expect(total).toBe(5000);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
