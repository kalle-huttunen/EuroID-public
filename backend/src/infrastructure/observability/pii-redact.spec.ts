/**
 * Test the PII redaction logic directly.
 * We test the internal redactPii function behavior through the piiRedactFormat.
 */

import { piiRedactFormat, safeLog } from './pii-redact.format';

describe('PII Redact Format', () => {
  const fmt = piiRedactFormat();

  // Helper: transform calls the format function with a logform-compatible info object
  function redact(info: Record<string, unknown>) {
    return fmt.transform({ level: 'info', message: 'test', ...info } as any);
  }

  it('should redact firstName', () => {
    const result = redact({ firstName: 'John' }) as any;
    expect(result.firstName).toBe('[REDACTED]');
  });

  it('should redact lastName', () => {
    const result = redact({ lastName: 'Doe' }) as any;
    expect(result.lastName).toBe('[REDACTED]');
  });

  it('should redact email', () => {
    const result = redact({ email: 'john@example.com' }) as any;
    expect(result.email).toBe('[REDACTED]');
  });

  it('should redact clientSecret', () => {
    const result = redact({ clientSecret: 'super-secret' }) as any;
    expect(result.clientSecret).toBe('[REDACTED]');
  });

  it('should redact password', () => {
    const result = redact({ password: 'p@ssw0rd' }) as any;
    expect(result.password).toBe('[REDACTED]');
  });

  it('should redact nationalId, taxId, address, displayName', () => {
    const result = redact({
      nationalId: '123456789',
      taxId: 'TAX-001',
      address: '123 Main St',
      displayName: 'John Doe',
    }) as any;
    expect(result.nationalId).toBe('[REDACTED]');
    expect(result.taxId).toBe('[REDACTED]');
    expect(result.address).toBe('[REDACTED]');
    expect(result.displayName).toBe('[REDACTED]');
  });

  it('should NOT redact non-PII fields', () => {
    const result = redact({ departmentName: 'Engineering', status: 'ACTIVE' }) as any;
    expect(result.departmentName).toBe('Engineering');
    expect(result.status).toBe('ACTIVE');
  });

  it('should redact nested objects recursively', () => {
    const result = redact({
      user: { firstName: 'John', lastName: 'Doe', department: 'IT' },
    }) as any;
    expect(result.user.firstName).toBe('[REDACTED]');
    expect(result.user.lastName).toBe('[REDACTED]');
    expect(result.user.department).toBe('IT');
  });

  it('should redact within arrays', () => {
    const result = redact({
      users: [
        { firstName: 'John', email: 'j@test.com' },
        { firstName: 'Jane', email: 'jane@test.com' },
      ],
    }) as any;
    expect(result.users[0].firstName).toBe('[REDACTED]');
    expect(result.users[1].email).toBe('[REDACTED]');
  });

  it('should handle null and undefined values gracefully', () => {
    const result = redact({ firstName: null, lastName: undefined }) as any;
    // null/undefined values should still be redacted (they're PII fields)
    expect(result.firstName).toBe('[REDACTED]');
    expect(result.lastName).toBe('[REDACTED]');
  });

  it('should handle case-insensitive field matching (e.g., FirstName)', () => {
    // The redact normalizes to camelCase by lowering first char
    const result = redact({ FirstName: 'John' }) as any;
    expect(result.FirstName).toBe('[REDACTED]');
  });

  it('should preserve the log level and message', () => {
    const result = redact({}) as any;
    expect(result.level).toBe('info');
    expect(result.message).toBe('test');
  });

  it('should redact upn and userPrincipalName', () => {
    const result = redact({
      upn: 'john@contoso.com',
      userPrincipalName: 'jane@contoso.com',
    }) as any;
    expect(result.upn).toBe('[REDACTED]');
    expect(result.userPrincipalName).toBe('[REDACTED]');
  });

  it('should redact homePhone, businessPhone, mobilePhone', () => {
    const result = redact({
      homePhone: '+1-555-0100',
      businessPhone: '+1-555-0200',
      mobilePhone: '+1-555-0300',
    }) as any;
    expect(result.homePhone).toBe('[REDACTED]');
    expect(result.businessPhone).toBe('[REDACTED]');
    expect(result.mobilePhone).toBe('[REDACTED]');
  });

  it('should redact distinguishedName and dn', () => {
    const result = redact({
      distinguishedName: 'CN=John Doe,OU=Users,DC=contoso,DC=com',
      dn: 'CN=Jane Doe,OU=Users,DC=contoso,DC=com',
    }) as any;
    expect(result.distinguishedName).toBe('[REDACTED]');
    expect(result.dn).toBe('[REDACTED]');
  });

  it('should redact sAMAccountName and samAccountName', () => {
    const result = redact({
      sAMAccountName: 'jdoe',
      samAccountName: 'jsmith',
    }) as any;
    expect(result.sAMAccountName).toBe('[REDACTED]');
    expect(result.samAccountName).toBe('[REDACTED]');
  });

  it('should redact UPN field in log output', () => {
    const result = redact({ userPrincipalName: 'sensitive@company.com' }) as any;
    expect(result.userPrincipalName).toBe('[REDACTED]');
    expect(String(result.userPrincipalName)).not.toContain('sensitive');
  });

  it('matches a key whatever its casing, spaces and punctuation (camelCase, HR column names)', () => {
    const row = {
      sourceUserId: 'EMP-001',
      employeeId: 'E1',
      mobilePhone: '+358 40 123 4567',
      'First Name': 'Ada',
      'Last Name': 'Lovelace',
      'E-mail': 'ada@example.com',
      EmpID: '42',
      EMAIL: 'ADA@EXAMPLE.COM',
      user_principal_name: 'ada@corp.example',
      personalEmail: 'ada@home.example',
      managerEmail: 'boss@example.com',
      workPhone: '+358 9 123 4567',
      Department: 'Engineering',
    };

    const result = redact({ row }) as any;

    for (const key of Object.keys(row).filter((k) => k !== 'Department')) {
      expect([key, result.row[key]]).toEqual([key, '[REDACTED]']);
    }
    expect(result.row.Department).toBe('Engineering');
    expect(safeLog(row)).not.toMatch(/ada|lovelace|EMP-001|4567|boss/i);
  });
});

describe('safeLog', () => {
  it('should redact PII before stringifying', () => {
    const obj = { firstName: 'John', email: 'j@test.com', department: 'IT' };
    const str = safeLog(obj);
    expect(str).toContain('[REDACTED]');
    expect(str).not.toContain('John');
    expect(str).not.toContain('j@test.com');
    expect(str).toContain('IT');
  });

  it('should handle null and undefined', () => {
    expect(safeLog(null)).toBe('null');
    expect(safeLog(undefined)).toContain('undefined');
  });
});
