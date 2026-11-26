/**
 * Field mapping data -- example user and attribute mappings.
 * Extracted from ConfigDrawer to keep data separate from presentation.
 */

/** Example user data that flows through the mapping */
export const EXAMPLE_USER = {
    employeeNumber: 'EMP-10042',
    firstName: 'Alice',
    lastName: 'Johnson',
    email: 'alice.johnson@hr.acme.com',
    department: 'Finance',
    jobTitle: 'Financial Analyst',
    manager: 'bob.smith@hr.acme.com',
};

/**
 * Field mapping data with per-system attribute names and example values.
 * The `targets` keys must match the `fieldMappingKey` in the connector registry.
 */
export const FIELD_MAPPINGS = [
    {
        key: '1',
        hrField: 'employeeNumber',
        hrValue: EXAMPLE_USER.employeeNumber,
        euroIdField: 'employeeId',
        hubValue: EXAMPLE_USER.employeeNumber,
        transformation: 'Direct mapping',
        required: true,
        targets: {
            'Entra ID': { attr: 'employeeNumber', value: EXAMPLE_USER.employeeNumber },
        },
    },
    {
        key: '2',
        hrField: 'firstName',
        hrValue: EXAMPLE_USER.firstName,
        euroIdField: 'firstName',
        hubValue: EXAMPLE_USER.firstName,
        transformation: 'Direct mapping',
        required: true,
        targets: {
            'Entra ID': { attr: 'givenName', value: EXAMPLE_USER.firstName },
        },
    },
    {
        key: '3',
        hrField: 'lastName',
        hrValue: EXAMPLE_USER.lastName,
        euroIdField: 'lastName',
        hubValue: EXAMPLE_USER.lastName,
        transformation: 'Direct mapping',
        required: true,
        targets: {
            'Entra ID': { attr: 'surname', value: EXAMPLE_USER.lastName },
        },
    },
    {
        key: '4',
        hrField: 'email',
        hrValue: EXAMPLE_USER.email,
        euroIdField: 'email',
        hubValue: 'alice.johnson@acme.com',
        transformation: 'toLowerCase() + domain rewrite',
        required: true,
        targets: {
            'Entra ID': { attr: 'userPrincipalName', value: 'alice.johnson@acme.onmicrosoft.com' },
        },
    },
    {
        key: '5',
        hrField: 'department',
        hrValue: EXAMPLE_USER.department,
        euroIdField: 'departmentCode',
        hubValue: 'FIN',
        transformation: 'Code mapping (Finance → FIN)',
        required: false,
        targets: {
            'Entra ID': { attr: 'department', value: 'Finance' },
        },
    },
    {
        key: '6',
        hrField: 'jobTitle',
        hrValue: EXAMPLE_USER.jobTitle,
        euroIdField: 'jobTitle',
        hubValue: EXAMPLE_USER.jobTitle,
        transformation: 'Direct mapping',
        required: false,
        targets: {
            'Entra ID': { attr: 'jobTitle', value: EXAMPLE_USER.jobTitle },
        },
    },
    {
        key: '7',
        hrField: 'manager',
        hrValue: EXAMPLE_USER.manager,
        euroIdField: 'managerEmail',
        hubValue: 'bob.smith@acme.com',
        transformation: 'Lookup by email → DN/ID',
        required: false,
        targets: {
            'Entra ID': { attr: 'manager', value: 'bob.smith@acme.onmicrosoft.com' },
        },
    },
];
