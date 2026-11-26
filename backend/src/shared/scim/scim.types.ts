/** SCIM 2.0 User resource (RFC 7643 §4.1) */
export interface SCIMUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  meta?: SCIMMeta;
  userName: string;
  name?: {
    formatted?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
  };
  displayName?: string;
  emails?: Array<{
    value: string;
    type?: string;
    primary?: boolean;
  }>;
  phoneNumbers?: Array<{
    value: string;
    type?: string;
  }>;
  active?: boolean;
  title?: string;
  /** Enterprise extension (urn:ietf:params:scim:schemas:extension:enterprise:2.0:User) */
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'?: SCIMEnterprise;
}

/** SCIM Enterprise User extension */
export interface SCIMEnterprise {
  employeeNumber?: string;
  department?: string;
  division?: string;
  organization?: string;
  manager?: { value?: string; displayName?: string };
}

/** SCIM Group resource (RFC 7643 §4.2) */
export interface SCIMGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  meta?: SCIMMeta;
  displayName: string;
  members?: Array<{
    value: string;       // User ID
    display?: string;    // User displayName
    $ref?: string;       // URI reference
    type?: string;       // "User" or "Group"
  }>;
}

/** SCIM resource metadata */
export interface SCIMMeta {
  resourceType?: string;
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

/** SCIM List Response (RFC 7644 §3.4.2) */
export interface SCIMListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** SCIM Patch Operation (RFC 7644 §3.5.2) */
export interface SCIMPatchOp {
  schemas: string[];
  Operations: Array<{
    op: 'add' | 'remove' | 'replace';
    path?: string;
    value?: unknown;
  }>;
}
