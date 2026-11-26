/**
 * GoogleSheetsConnector — Config and types.
 *
 * Dev connector: Appends user rows to a Google Sheet via google-spreadsheet package.
 */

/** Configuration for GoogleSheetsConnector */
export interface GoogleSheetsConfig {
  /** Google Sheet ID from URL (/d/SHEET_ID/edit) */
  sheetId: string;
  /** JSON string of service account credentials */
  serviceAccountJson: string;
  /** Worksheet name (optional, default: first sheet) */
  sheetName?: string;
}

/** Expected column headers for the provisioned sheet (first row). Document for users. */
export const SHEET_HEADERS = [
  'Email',
  'FirstName',
  'LastName',
  'JobTitle',
  'Department',
  'ProvisionedAt',
] as const;
