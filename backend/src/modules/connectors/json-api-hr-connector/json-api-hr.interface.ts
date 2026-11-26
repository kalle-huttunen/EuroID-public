import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { HR_STATUS_FIELD } from '../hr/hr-lifecycle-fields';
import { GITHUB_LOGIN_TARGET, type CustomAttributeTarget } from '../hr/hr-custom-attributes';

/**
 * Default field mapping: JSON property → StandardUserDto field (or `hrStatus`, see
 * hr/hr-lifecycle-fields.ts, or `customAttributes.<key>`, see hr/hr-custom-attributes.ts).
 */
export const DEFAULT_JSON_FIELD_MAP: Record<
  string,
  keyof Partial<StandardUserDto> | typeof HR_STATUS_FIELD | CustomAttributeTarget
> = {
  emp_id: 'sourceUserId',
  employeeId: 'sourceUserId',
  sourceUserId: 'sourceUserId',
  first_name: 'firstName',
  firstName: 'firstName',
  last_name: 'lastName',
  lastName: 'lastName',
  email: 'email',
  job_title: 'jobTitle',
  jobTitle: 'jobTitle',
  department: 'departmentName',
  departmentName: 'departmentName',
  dept: 'departmentName',
  employment_type: 'employmentType',
  employmentType: 'employmentType',
  phone: 'mobilePhone',
  mobilePhone: 'mobilePhone',
  location: 'location',
  start_date: 'startDate',
  startDate: 'startDate',
  hire_date: 'startDate',
  hireDate: 'startDate',
  end_date: 'endDate',
  endDate: 'endDate',
  termination_date: 'endDate',
  terminationDate: 'endDate',
  status: HR_STATUS_FIELD,
  employment_status: HR_STATUS_FIELD,
  employmentStatus: HR_STATUS_FIELD,
  github_login: GITHUB_LOGIN_TARGET,
  githubLogin: GITHUB_LOGIN_TARGET,
};

/** Config schema for JsonApiHrConnector */
export interface JsonApiHrConfig {
  /** HTTP endpoint returning JSON array, or local file path (required) */
  url: string;
  /** HTTP method. Default: "GET" */
  method?: string;
  /** Maps JSON property names to StandardUserDto fields */
  fieldMap?: Record<string, string>;
  /** Path to array in response, e.g. "data" or "users". Omit if response is a direct array. */
  responsePath?: string;
  /** Source system name. Default: "json-api-hr" */
  sourceSystem?: string;
  /** Tenant ID */
  tenantId?: string;
  /** HTTP authentication. Default: "none". Ignored for local file paths. */
  authType?: 'none' | 'bearer' | 'header';
  /** Sent as `Authorization: Bearer <token>` for authType "bearer". Secret: redacted in API responses. */
  bearerToken?: string;
  /** Header name for authType "header", e.g. "X-API-Key". */
  authHeaderName?: string;
  /** Header value for authType "header". Secret: redacted in API responses. */
  authHeaderSecret?: string;
}

/** Credentials resolved from JsonApiHrConfig for one request. */
export type JsonApiHrAuth =
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string };
