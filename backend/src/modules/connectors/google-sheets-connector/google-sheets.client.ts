/**
 * GoogleSheetsClient — Wrapper for google-spreadsheet package.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { GoogleSheetsConfig } from './google-sheets.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';

@Injectable()
export class GoogleSheetsClient {
  private readonly logger = new Logger(GoogleSheetsClient.name);

  private parseCredentials(serviceAccountJson: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(serviceAccountJson) as Record<string, unknown>;
      if (!parsed.client_email || !parsed.private_key) {
        throw new BadRequestException(
          'Invalid service account JSON: missing client_email or private_key',
        );
      }
      return parsed;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(`Invalid serviceAccountJson: ${message}`);
    }
  }

  /**
   * Append a user row to the sheet.
   * First row must be headers: Email, FirstName, LastName, JobTitle, Department, ProvisionedAt
   */
  async appendRow(
    config: GoogleSheetsConfig,
    user: StandardUserDto,
  ): Promise<{ targetUserId: string }> {
    const credentials = this.parseCredentials(config.serviceAccountJson);
    const auth = new JWT({
      email: credentials.client_email as string,
      key: credentials.private_key as string,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(config.sheetId, auth);
    await doc.loadInfo();

    const sheet = config.sheetName
      ? (doc.sheetsByTitle[config.sheetName] ?? doc.sheetsByIndex[0])
      : doc.sheetsByIndex[0];

    if (!sheet) {
      throw new BadRequestException('No worksheet found. Ensure sheet exists.');
    }

    const provisionedAt = new Date().toISOString();
    const rowData: Record<string, string> = {
      Email: user.email,
      FirstName: user.firstName ?? '',
      LastName: user.lastName ?? '',
      JobTitle: user.jobTitle ?? '',
      Department: user.departmentName ?? '',
      ProvisionedAt: provisionedAt,
    };

    // Raw (valueInputOption RAW): a value from an HR feed that starts with "=" stays text; the
    // default, USER_ENTERED, makes it a formula (=IMPORTDATA(...) could send the sheet out)
    await sheet.addRow(rowData, { raw: true });
    const targetUserId = `sheets-${user.email}-${Date.now()}`;
    return { targetUserId };
  }

  /**
   * Health check: load sheet and verify access.
   */
  async healthCheck(config: GoogleSheetsConfig): Promise<boolean> {
    try {
      const credentials = this.parseCredentials(config.serviceAccountJson);
      const auth = new JWT({
        email: credentials.client_email as string,
        key: credentials.private_key as string,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const doc = new GoogleSpreadsheet(config.sheetId, auth);
      await doc.loadInfo();
      // Verify we can read sheet metadata
      void doc.title;
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[HEALTH] Google Sheets check failed: ${message}`);
      return false;
    }
  }
}
