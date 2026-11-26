/**
 * POST /identity and PATCH /identity/:id bind CreateUserDto and UpdateUserDto. The actor of a
 * write is the authenticated user (IdentityMutationService falls back to `dto.createdBy` only
 * when no actor is known), so the request schemas strip `createdBy` and `updatedBy`: a caller
 * cannot record someone else as the creator or last editor.
 */

import { CreateUserSchema } from './create-user.dto';
import { UpdateUserSchema } from './update-user.dto';

const user = {
  sourceSystem: 'manual-ui',
  sourceUserId: 'u-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  status: 'ACTIVE',
};

describe('identity write schemas drop client-supplied actor fields', () => {
  it('POST /identity body: createdBy and updatedBy are stripped', () => {
    const parsed = CreateUserSchema.parse({
      ...user,
      createdBy: 'someone-else@example.com',
      updatedBy: 'someone-else@example.com',
    });

    expect(parsed).not.toHaveProperty('createdBy');
    expect(parsed).not.toHaveProperty('updatedBy');
    expect(parsed.email).toBe('ada@example.com');
  });

  it('PATCH /identity/:id body: createdBy and updatedBy are stripped', () => {
    const parsed = UpdateUserSchema.parse({
      firstName: 'Augusta',
      createdBy: 'someone-else@example.com',
      updatedBy: 'someone-else@example.com',
    });

    expect(parsed).toEqual({ firstName: 'Augusta' });
  });
});
