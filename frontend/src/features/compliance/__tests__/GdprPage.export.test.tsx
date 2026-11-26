/**
 * GdprPage access export: GET /identity/:id/dsar-export saved as a JSON file through the browser
 * (a Blob link), the page showing only what the file holds by count, and the API's message when
 * the export is refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { GdprPage } from '../GdprPage';
import {
  ADA_EMAIL,
  ADA_ID,
  ADA_PERSONAL_EMAIL,
  ADA_PHONE,
  apiError,
  dsarPackage,
  mockDelete,
  mockGet,
  mockPost,
  pickPerson,
  serve,
} from './GdprPage.fixtures';
import { EXPORT_COUNT_LABEL } from '../gdpr-labels';

let mockRoles = ['super-admin', 'operator', 'viewer'];
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => mockRoles.includes(role),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const BLOB_URL = 'blob:http://localhost/dsar';

/** jsdom has no object URLs and no downloads: record what the page saved. */
const createObjectURL = vi.fn((_blob: Blob) => BLOB_URL);
const revokeObjectURL = vi.fn();
let downloads: Array<{ href: string; download: string }> = [];

/** Node's Blob reads itself; jsdom's (no text()) through its FileReader. */
function readBlob(blob: Blob): Promise<string> {
  if (typeof (blob as { text?: unknown }).text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('GdprPage access export', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ['super-admin', 'operator', 'viewer'];
    downloads = [];
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it(
    'saves the export as a JSON file named by id and time, and shows only the counts',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      await user.click(await screen.findByRole('button', { name: /Download export/ }));

      await waitFor(() => expect(downloads).toHaveLength(1));
      expect(mockGet).toHaveBeenCalledWith(`/api/v1/identity/${ADA_ID}/dsar-export`);
      // The file name carries the id and the export time, never the person's name or email.
      expect(downloads[0].download).toMatch(
        new RegExp(`^dsar-export-${ADA_ID}-\\d{8}-\\d{6}\\.json$`),
      );
      expect(downloads[0].href).toBe(BLOB_URL);
      expect(revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
      // The file is the package as the API answered it.
      const blob = createObjectURL.mock.calls[0][0];
      expect(blob.type).toBe('application/json');
      expect(JSON.parse(await readBlob(blob))).toEqual(dsarPackage);

      expect(await screen.findByText(downloads[0].download)).toBeInTheDocument();
      const count = (label: string) =>
        screen.getByText(label).closest('tr')?.querySelector('.ant-descriptions-item-content')
          ?.textContent;
      expect(count('Timeline events')).toBe('2');
      expect(count('Audit entries filed under the person')).toBe('1');
      expect(count('Access review items')).toBe('0');
      expect(count('Access review exclusions')).toBe('1');
      expect(count('Access the person holds (policy and request grants)')).toBe('3');
      expect(count('Consent records')).toBe('2');
      // HX-G3: the records of the erasure scope (all collections together) and the admin identities
      expect(count(EXPORT_COUNT_LABEL.records)).toBe('3');
      expect(count(EXPORT_COUNT_LABEL.linkedAdminIdentities)).toBe('1');
      // The unmasked values in the file are never put on screen.
      expect(document.body.textContent).not.toContain(ADA_PHONE);
      expect(document.body.textContent).not.toContain(ADA_PERSONAL_EMAIL);
      expect(downloads[0].download).not.toContain(ADA_EMAIL);
    },
  );

  it(
    'shows the API message when the export is refused, and saves no file',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      const served = mockGet.getMockImplementation()!;
      mockGet.mockImplementation((url: string, config?: unknown) =>
        url.endsWith('/dsar-export')
          ? Promise.reject(apiError(404, `Identity ${ADA_ID} not found`))
          : served(url, config),
      );
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      await user.click(await screen.findByRole('button', { name: /Download export/ }));

      expect(
        await screen.findByText(`Export failed: Identity ${ADA_ID} not found`),
      ).toBeInTheDocument();
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(downloads).toHaveLength(0);
    },
  );
});
