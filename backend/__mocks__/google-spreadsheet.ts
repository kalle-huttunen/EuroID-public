/**
 * Mock for google-spreadsheet (ESM-only) to avoid Jest parse errors in tests
 * that transitively import it. Provides minimal stubs for GoogleSpreadsheet.
 *
 * Usage pattern mirrors google-sheets.client.ts:
 *   const doc = new GoogleSpreadsheet(sheetId, auth);
 *   await doc.loadInfo();
 *   const sheet = doc.sheetsByTitle['Sheet1'];
 *   await sheet.addRow({ ... });
 */

const mockSheet = {
  addRow: jest.fn().mockResolvedValue({}),
  getRows: jest.fn().mockResolvedValue([]),
  headerValues: ['Email', 'FirstName', 'LastName', 'JobTitle', 'Department', 'ProvisionedAt'],
};

class MockGoogleSpreadsheet {
  readonly spreadsheetId: string;
  title = 'Mock Spreadsheet';
  sheetsByIndex: Array<typeof mockSheet> = [mockSheet];
  sheetsByTitle: Record<string, typeof mockSheet> = { Sheet1: mockSheet };

  constructor(sheetId: string, _auth?: unknown) {
    this.spreadsheetId = sheetId;
  }

  async loadInfo(): Promise<void> {
    // no-op
  }
}

export const GoogleSpreadsheet = MockGoogleSpreadsheet;
