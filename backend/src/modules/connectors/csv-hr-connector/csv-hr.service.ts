import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const csv = require('csv-parser');
import {
  IHrConnector,
  IHrConnectorWriteBack,
  type HrSourceCheck,
} from '../hr/interfaces/hr-connector.interface';
import { StandardUserDto, UserStatus, EmploymentType } from '@shared/dtos/standard-user.dto';
import { CSV_HR_MAX_ROWS, CSV_HR_MAX_FILE_SIZE_MB } from '@infrastructure/config/defaults';
import { DEFAULT_CSV_COLUMN_MAP, type CsvHrConfig } from './csv-hr.interface';
import { applyHrLifecycleFields, type HrFetchStats } from '../hr/hr-lifecycle-fields';
import { applyMappedCustomAttributes } from '../hr/hr-custom-attributes';
import { parseHrFieldMap } from '../hr/hr-field-map';
import { realpathOfExisting } from '../sandboxed-path';

@Injectable()
export class CsvHrService implements IHrConnector, IHrConnectorWriteBack {
  readonly sourceName = 'csv-hr';
  readonly writeBackCapableFields: string[] = [];
  private readonly logger = new Logger(CsvHrService.name);

  /**
   * Resolve and sandbox a file path against CSV_HR_ALLOWED_DIR.
   * Prevents path traversal attacks (e.g. ../../../../etc/passwd), symlinks included: the check
   * is made on the real path (realpath of the directory and of the file, or of its nearest
   * existing parent when it does not exist), and that real path is what is read. The error names
   * no server path (it reaches the health check answer and the sync status); the log does.
   * In production, CSV_HR_ALLOWED_DIR is required (IV-2).
   */
  private sandboxFilePath(filePath: string): string {
    const envDir = process.env.CSV_HR_ALLOWED_DIR;
    if (process.env.NODE_ENV === 'production' && !envDir) {
      throw new BadRequestException(
        'CsvHrConnector: CSV_HR_ALLOWED_DIR is required in production. Set it to a directory containing CSV files.',
      );
    }
    let allowedDir: string;
    let resolvedPath: string;
    try {
      allowedDir = fs.realpathSync(path.resolve(envDir || process.cwd()));
      resolvedPath = realpathOfExisting(path.resolve(allowedDir, filePath));
    } catch (err: unknown) {
      this.logger.warn(
        `CsvHrConnector: cannot resolve ${filePath} under ${envDir || process.cwd()}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        'CsvHrConnector: The file path cannot be resolved by the server',
      );
    }
    if (!resolvedPath.startsWith(allowedDir + path.sep) && resolvedPath !== allowedDir) {
      this.logger.warn(`CsvHrConnector: ${resolvedPath} is outside ${allowedDir}: refused`);
      throw new BadRequestException(
        'CsvHrConnector: The file path is outside the allowed directory (CSV_HR_ALLOWED_DIR)',
      );
    }
    return resolvedPath;
  }

  async fetchUsers(
    config: Record<string, unknown>,
    tenantId?: string,
    stats?: HrFetchStats,
  ): Promise<Partial<StandardUserDto>[]> {
    const {
      filePath,
      columnMap,
      sourceSystem,
      tenantId: configTenantId,
    } = config as unknown as CsvHrConfig;
    // When neither caller nor connector config provides tenantId, use DEFAULT_TENANT_ID for backward compatibility.
    const effectiveTenantId =
      tenantId ?? configTenantId ?? (process.env.DEFAULT_TENANT_ID || 'default');
    const effectiveSourceSystem = sourceSystem ?? this.sourceName;
    // JSON text as the API stores it, or an object; a wrong map fails the run with a 400
    const effectiveColumnMap = parseHrFieldMap(columnMap, 'columnMap') ?? DEFAULT_CSV_COLUMN_MAP;

    if (!filePath || typeof filePath !== 'string') {
      throw new BadRequestException('CsvHrConnector: filePath is required');
    }

    const resolvedPath = this.sandboxFilePath(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new BadRequestException(`CsvHrConnector: File not found: ${filePath}`);
    }

    const rows = await this.parseCsv(resolvedPath);
    const users: Partial<StandardUserDto>[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = this.mapRowToUser(
        row,
        effectiveColumnMap,
        effectiveSourceSystem,
        effectiveTenantId,
      );
      if (mapped) {
        users.push(mapped);
        stats?.sourceRows?.push(i + 2);
      } else {
        if (stats) stats.skipped++;
        // Names only, no values: safeLog redacts by key and misses headers such as "First Name"
        this.logger.warn(
          `CsvHrConnector: Skipping row ${i + 2} (missing sourceUserId or email), ` +
            `columns: ${Object.keys(row).join(', ')}`,
        );
      }
    }

    return users;
  }

  async updateUserFields(
    _externalId: string,
    _fields: Record<string, unknown>,
    _config: Record<string, unknown>,
    _tenantId?: string,
  ): Promise<{ success: boolean; updatedFields: string[]; reason?: string }> {
    return { success: false, updatedFields: [], reason: 'read-only' };
  }

  async healthCheck(config: Record<string, unknown>): Promise<boolean> {
    const { filePath } = config as unknown as CsvHrConfig;
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }
    try {
      const resolvedPath = this.sandboxFilePath(filePath);
      return fs.existsSync(resolvedPath);
    } catch {
      return false;
    }
  }

  /**
   * POST /connectors/csv-hr/health-check: what can be checked without importing. The column map
   * parses as ingest parses it, the file is inside CSV_HR_ALLOWED_DIR once symlinks are resolved
   * (sandboxFilePath, the message ingest gives, no server path), exists, is a file the server can
   * read and is within CSV_HR_MAX_FILE_SIZE_MB. CSV HR reads `filePath` only: there is no upload
   * to check.
   */
  async checkSource(config: Record<string, unknown>): Promise<HrSourceCheck> {
    const { filePath, columnMap } = config as unknown as CsvHrConfig;
    let resolvedPath: string;
    try {
      parseHrFieldMap(columnMap, 'columnMap');
      if (!filePath || typeof filePath !== 'string') {
        return { healthy: false, error: 'filePath is required' };
      }
      resolvedPath = this.sandboxFilePath(filePath);
    } catch (error: unknown) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolvedPath);
    } catch (error: unknown) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        healthy: false,
        error: missing ? `File not found: ${filePath}` : `${filePath} cannot be read by the server`,
      };
    }
    if (!stat.isFile()) return { healthy: false, error: `${filePath} is not a file` };
    try {
      await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch {
      return { healthy: false, error: `${filePath} cannot be read by the server` };
    }
    const maxBytes = CSV_HR_MAX_FILE_SIZE_MB * 1024 * 1024;
    if (stat.size > maxBytes) {
      return {
        healthy: false,
        error: `${filePath} is ${stat.size} bytes, over the limit of ${maxBytes} (CSV_HR_MAX_FILE_SIZE_MB)`,
      };
    }
    return {
      healthy: true,
      message: `${filePath} can be read (${stat.size} bytes) and the column map is valid`,
    };
  }

  private async parseCsv(filePath: string): Promise<Record<string, string>[]> {
    const stat = fs.statSync(filePath);
    const maxBytes = CSV_HR_MAX_FILE_SIZE_MB * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new BadRequestException(
        `CsvHrConnector: File size ${stat.size} exceeds limit ${maxBytes} (CSV_HR_MAX_FILE_SIZE_MB=${CSV_HR_MAX_FILE_SIZE_MB})`,
      );
    }

    return new Promise((resolve, reject) => {
      const rows: Record<string, string>[] = [];
      const stream = fs.createReadStream(filePath).pipe(csv());
      stream
        .on('data', (row: Record<string, string>) => {
          rows.push(row);
          if (rows.length > CSV_HR_MAX_ROWS) {
            stream.destroy();
            reject(
              new BadRequestException(
                `CsvHrConnector: Row count exceeds limit ${CSV_HR_MAX_ROWS} (CSV_HR_MAX_ROWS). Possible OOM DoS.`,
              ),
            );
          }
        })
        .on('end', () => resolve(rows))
        .on('error', (err: unknown) => reject(err));
    });
  }

  private mapRowToUser(
    row: Record<string, string>,
    columnMap: Record<string, string>,
    sourceSystem: string,
    tenantId: string,
  ): Partial<StandardUserDto> | null {
    const mapped: Record<string, string> = {};
    for (const [csvHeader, dtoField] of Object.entries(columnMap)) {
      const value = row[csvHeader]?.trim();
      if (value !== undefined && value !== '') {
        mapped[dtoField] = value;
      }
    }

    const sourceUserId = mapped.sourceUserId ?? mapped.employeeId ?? mapped.email;
    const email = mapped.email;

    if (!sourceUserId || !email) {
      return null;
    }

    const user: Partial<StandardUserDto> = {
      sourceSystem,
      sourceUserId: String(sourceUserId),
      tenantId,
      firstName: mapped.firstName ?? '',
      lastName: mapped.lastName ?? '',
      email: String(email),
      status: UserStatus.ACTIVE,
    };

    if (mapped.jobTitle) user.jobTitle = mapped.jobTitle;
    if (mapped.departmentName) user.departmentName = mapped.departmentName;
    if (mapped.employeeId) user.employeeId = mapped.employeeId;
    if (mapped.employeeNumber) user.employeeNumber = mapped.employeeNumber;
    if (mapped.employmentType) {
      const normalized = mapped.employmentType
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_');
      if (Object.values(EmploymentType).includes(normalized as EmploymentType)) {
        user.employmentType = normalized as EmploymentType;
      }
    }
    if (mapped.mobilePhone) user.mobilePhone = mapped.mobilePhone;
    if (mapped.location) user.location = mapped.location;
    applyHrLifecycleFields(user, mapped, (field) =>
      this.logger.warn(`CsvHrConnector: Ignoring ${field} that is not a date for ${sourceUserId}`),
    );
    applyMappedCustomAttributes(user, mapped);

    return user;
  }
}
