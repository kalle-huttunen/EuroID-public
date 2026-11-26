/** Centralized pagination constants */
export const PAGE_SIZES = {
  SMALL: 5,
  DEFAULT: 10,
  MEDIUM: 20,
  LARGE: 50,
  XLARGE: 100,
} as const;

export const DEFAULT_API_LIMIT = 50;

/** Page size for Risk Dashboard anomaly list */
export const RISK_DASHBOARD_PAGE_SIZE = 50;

/** Matches a person picker shows per search (GET /identity?q=); typing more narrows them. */
export const IDENTITY_PICKER_LIMIT = 50;

/** Page size the audit CSV export reads with (the API's maximum for GET /audit). */
export const AUDIT_EXPORT_PAGE_SIZE = 100;

/** Most events one audit CSV export holds; above it the export says to narrow the filter. */
export const AUDIT_EXPORT_MAX_EVENTS = 10_000;
