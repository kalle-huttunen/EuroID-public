import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { HR_STATUS_FIELD } from '../hr/hr-lifecycle-fields';
import { GITHUB_LOGIN_TARGET, type CustomAttributeTarget } from '../hr/hr-custom-attributes';

/**
 * Default column mapping: CSV header → StandardUserDto field (or `hrStatus`, see
 * hr/hr-lifecycle-fields.ts, or `customAttributes.<key>`, see hr/hr-custom-attributes.ts).
 * Used when no columnMap is provided in config.
 */
export const DEFAULT_CSV_COLUMN_MAP: Record<
  string,
  keyof Partial<StandardUserDto> | typeof HR_STATUS_FIELD | CustomAttributeTarget
> = {
  EmpID: 'sourceUserId',
  'Employee ID': 'sourceUserId',
  'First Name': 'firstName',
  'Last Name': 'lastName',
  Email: 'email',
  'Job Title': 'jobTitle',
  Department: 'departmentName',
  'Department Name': 'departmentName',
  'Employment Type': 'employmentType',
  Phone: 'mobilePhone',
  Location: 'location',
  'Start Date': 'startDate',
  'End Date': 'endDate',
  'Termination Date': 'endDate',
  Status: HR_STATUS_FIELD,
  'Employment Status': HR_STATUS_FIELD,
  'GitHub Login': GITHUB_LOGIN_TARGET,
};

/** Config schema for CsvHrConnector */
export interface CsvHrConfig {
  /** Path to CSV file (required) */
  filePath: string;
  /**
   * Maps CSV column headers to StandardUserDto fields, `hrStatus` or `customAttributes.<key>`.
   * Defaults to DEFAULT_CSV_COLUMN_MAP.
   */
  columnMap?: Record<string, string>;
  /** Source system name for survivorship. Default: "csv-hr" */
  sourceSystem?: string;
  /** Tenant ID if all rows are for one tenant */
  tenantId?: string;
}
