/**
 * Test User Generator for EuroID
 *
 * Generates 10 realistic StandardUserDto records with varied departments,
 * job titles, locations, and employment types. Users are tagged with
 * "test-batch" for easy identification and cleanup.
 *
 * Can be used as:
 * 1. Standalone script: npx ts-node src/scripts/generate-test-users.ts
 * 2. Imported by the batch-provision controller
 */

import {
  StandardUserDto,
  UserStatus,
  EmploymentType,
  UserPriority,
} from '@shared/dtos/standard-user.dto';

// ==========================================
// DATA POOLS
// ==========================================

export const DEPARTMENTS = [
  { code: 'ENG-001', name: 'Engineering', division: 'Technology' },
  { code: 'SALES-001', name: 'Sales', division: 'Revenue' },
  { code: 'MKT-001', name: 'Marketing', division: 'Revenue' },
  { code: 'HR-001', name: 'Human Resources', division: 'Operations' },
  { code: 'FIN-001', name: 'Finance', division: 'Operations' },
  { code: 'LEGAL-001', name: 'Legal', division: 'Operations' },
  { code: 'PROD-001', name: 'Product', division: 'Technology' },
  { code: 'DESIGN-001', name: 'Design', division: 'Technology' },
  { code: 'SUP-001', name: 'Support', division: 'Customer Success' },
  { code: 'OPS-001', name: 'Operations', division: 'Operations' },
];

export const JOB_TITLES_BY_DEPT: Record<string, string[]> = {
  Engineering: [
    'Software Engineer',
    'Senior Backend Developer',
    'DevOps Engineer',
    'QA Engineer',
    'Tech Lead',
  ],
  Sales: ['Account Executive', 'Sales Manager', 'Business Development Rep', 'Sales Engineer'],
  Marketing: ['Marketing Manager', 'Content Strategist', 'Growth Analyst', 'Brand Designer'],
  'Human Resources': [
    'HR Business Partner',
    'Recruiter',
    'People Operations Manager',
    'Compensation Analyst',
  ],
  Finance: ['Financial Analyst', 'Controller', 'Accounts Payable Specialist', 'FP&A Manager'],
  Legal: ['Corporate Counsel', 'Compliance Officer', 'Paralegal', 'Privacy Analyst'],
  Product: ['Product Manager', 'Senior Product Owner', 'Product Analyst', 'UX Researcher'],
  Design: ['UI Designer', 'UX Designer', 'Design System Lead', 'Visual Designer'],
  Support: ['Support Engineer', 'Customer Success Manager', 'Technical Support Lead'],
  Operations: [
    'Operations Manager',
    'Project Coordinator',
    'Business Analyst',
    'Facilities Manager',
  ],
};

export const LOCATIONS = [
  {
    code: 'SE-STO',
    office: 'Stockholm HQ',
    city: 'Stockholm',
    state: 'Stockholm',
    country: 'SE',
    tz: 'Europe/Stockholm',
    postal: '111 29',
  },
  {
    code: 'DE-BER',
    office: 'Berlin Office',
    city: 'Berlin',
    state: 'Berlin',
    country: 'DE',
    tz: 'Europe/Berlin',
    postal: '10115',
  },
  {
    code: 'UK-LON',
    office: 'London Office',
    city: 'London',
    state: 'England',
    country: 'GB',
    tz: 'Europe/London',
    postal: 'EC2A 1NT',
  },
  {
    code: 'US-NYC',
    office: 'New York Office',
    city: 'New York',
    state: 'NY',
    country: 'US',
    tz: 'America/New_York',
    postal: '10001',
  },
  {
    code: 'FI-HEL',
    office: 'Helsinki Office',
    city: 'Helsinki',
    state: 'Uusimaa',
    country: 'FI',
    tz: 'Europe/Helsinki',
    postal: '00100',
  },
];

// European-flavored first/last names
const FIRST_NAMES = [
  'Erik',
  'Anna',
  'Lars',
  'Sophia',
  'Mikael',
  'Elena',
  'Johan',
  'Katarina',
  'Lukas',
  'Freya',
];
const LAST_NAMES = [
  'Lindqvist',
  'Johansson',
  'Müller',
  'Petrov',
  'Kowalski',
  'Bergström',
  'Nielsen',
  'Fischer',
  'Dubois',
  'Virtanen',
];

// ==========================================
// GENERATOR
// ==========================================

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a batch of realistic test users.
 * @param count - Number of users to generate (default: 10)
 * @param domain - Email domain to use (should match your Entra tenant domain)
 */
export function generateTestUsers(count: number = 10, domain?: string): StandardUserDto[] {
  const emailDomain = domain || process.env.ENTRA_DEFAULT_DOMAIN || 'yourtenant.onmicrosoft.com';
  const users: StandardUserDto[] = [];
  const usedEmails = new Set<string>();
  const batchTimestamp = new Date().toISOString().slice(0, 10); // e.g. "2026-02-07"

  for (let i = 0; i < count; i++) {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length];
    const lastName = LAST_NAMES[i % LAST_NAMES.length];
    const dept = DEPARTMENTS[i % DEPARTMENTS.length];
    const location = LOCATIONS[i % LOCATIONS.length];
    const jobTitles = JOB_TITLES_BY_DEPT[dept.name] || ['Specialist'];
    const jobTitle = pick(jobTitles);

    // Build unique email: firstname.lastname{index}@domain
    let emailLocal = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
    if (usedEmails.has(emailLocal)) {
      emailLocal = `${emailLocal}${i}`;
    }
    usedEmails.add(emailLocal);
    const email = `${emailLocal}@${emailDomain}`;

    const user: StandardUserDto = {
      // Identifiers
      sourceSystem: 'euroid-test-generator',
      sourceUserId: `TEST-${String(i + 1).padStart(4, '0')}`,
      tenantId: 'euroid-default',

      // Personal
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`,
      email,
      userPrincipalName: email,

      // Employment
      jobTitle,
      departmentCode: dept.code,
      departmentName: dept.name,
      division: dept.division,
      costCenter: `CC-${dept.code}`,
      employeeId: `EMP-${String(1000 + i).padStart(5, '0')}`,
      employmentType: i % 5 === 4 ? EmploymentType.CONTRACTOR : EmploymentType.FULL_TIME,
      startDate: new Date(`2026-02-10`),

      // Location
      location: location.code,
      officeName: location.office,
      officeLocation: location.office,
      city: location.city,
      stateProvince: location.state,
      countryCode: location.country,
      postalCode: location.postal,
      timezone: location.tz,

      // Status
      status: UserStatus.PENDING,
      priority: i === 0 ? UserPriority.VIP : UserPriority.STANDARD,

      // Extensibility
      customAttributes: {
        batchId: `test-batch-${batchTimestamp}`,
        generatedBy: 'euroid-test-generator',
      },
      tags: ['test-batch', `batch-${batchTimestamp}`, 'entra-provision'],

      // Metadata
      createdBy: 'test-generator',
      schemaVersion: '2.0.0',
    };

    users.push(user);
  }

  return users;
}

// ==========================================
// CLI MODE - run directly with ts-node
// ==========================================
if (require.main === module) {
  const { Logger } = require('@nestjs/common');
  const logger = new Logger('GenerateTestUsers');
  const users = generateTestUsers(10);
  logger.log(`\nGenerated ${users.length} test users:\n`);
  for (const u of users) {
    logger.log(
      `  ${u.sourceUserId} | ${(u.displayName ?? '').padEnd(22)} | ${u.email.padEnd(40)} | ${u.departmentName?.padEnd(18)} | ${u.city}`,
    );
  }
  logger.log(`\nTo insert into MongoDB, use the batch-provision API endpoint.`);
}
