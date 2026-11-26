/**
 * Field validation of the identity write bodies the API binds: POST /identity (CreateUserDto) and
 * PATCH /identity/:id (UpdateUserDto). A body that fails here is a 400 through the Zod pipe.
 * The actor fields are in user-actor-fields.dto.spec.ts.
 */
import { CreateUserSchema } from './create-user.dto';
import { UpdateUserSchema } from './update-user.dto';

const valid = {
  sourceSystem: 'manual-ui',
  sourceUserId: 'u-1',
  firstName: 'Matti',
  lastName: 'Virtanen',
  email: 'matti.virtanen@example.com',
  status: 'ACTIVE',
};

/** The paths Zod rejects the body for. */
function rejectedPaths(result: { success: boolean; error?: { issues: { path: unknown[] }[] } }) {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('POST /identity body (CreateUserSchema)', () => {
  it('accepts the required fields with optional ones', () => {
    const result = CreateUserSchema.safeParse({
      ...valid,
      middleName: 'Johannes',
      jobTitle: 'Senior Developer',
      departmentName: 'Engineering',
      employmentType: 'FULL_TIME',
      customAttributes: { badge: 'gold' },
      tags: ['engineering', 'helsinki'],
    });

    expect(result.success).toBe(true);
  });

  it.each(['sourceSystem', 'sourceUserId', 'firstName', 'lastName', 'email', 'status'])(
    'rejects a body without %s',
    (field) => {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];

      expect(rejectedPaths(CreateUserSchema.safeParse(body))).toEqual([field]);
    },
  );

  it('rejects an invalid email', () => {
    const result = CreateUserSchema.safeParse({ ...valid, email: 'not-an-email' });

    expect(rejectedPaths(result)).toEqual(['email']);
  });

  it('rejects a status that is not a user status', () => {
    const result = CreateUserSchema.safeParse({ ...valid, status: 'UNKNOWN' });

    expect(rejectedPaths(result)).toEqual(['status']);
  });

  it('rejects customAttributes with more than 50 keys', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, 'v']));

    const result = CreateUserSchema.safeParse({ ...valid, customAttributes: tooMany });

    expect(rejectedPaths(result)).toEqual(['customAttributes']);
  });

  it('drops a tenantId: the tenant comes from the request context', () => {
    const parsed = CreateUserSchema.parse({ ...valid, tenantId: 'other-tenant' });

    expect(parsed).not.toHaveProperty('tenantId');
  });
});

describe('PATCH /identity/:id body (UpdateUserSchema)', () => {
  it('accepts a partial update and an empty body', () => {
    expect(
      UpdateUserSchema.parse({ jobTitle: 'Lead Developer', departmentName: 'Platform' }),
    ).toEqual({ jobTitle: 'Lead Developer', departmentName: 'Platform' });
    expect(UpdateUserSchema.parse({})).toEqual({});
  });

  it('still validates the fields it is given', () => {
    expect(rejectedPaths(UpdateUserSchema.safeParse({ email: 'not-an-email' }))).toEqual(['email']);
    expect(rejectedPaths(UpdateUserSchema.safeParse({ status: 'UNKNOWN' }))).toEqual(['status']);
  });

  it('drops a tenantId: the tenant comes from the request context', () => {
    expect(UpdateUserSchema.parse({ firstName: 'Augusta', tenantId: 'other-tenant' })).toEqual({
      firstName: 'Augusta',
    });
  });
});
