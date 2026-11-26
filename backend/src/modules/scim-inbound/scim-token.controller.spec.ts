/**
 * SCIM bearer tokens let an IdP create and change identities, so only a super-admin mints,
 * lists and revokes them; a minted token names the signed-in admin as its creator and its
 * plaintext is answered once, with its id and name only. The token service is mocked.
 */
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ParseObjectIdPipe } from '@shared/pipes/parse-object-id.pipe';
import { ScimTokenController } from './scim-token.controller';
import type { ScimTokenService } from './scim-token.service';
import { CreateScimTokenSchema, type CreateScimTokenDto } from './dto/create-scim-token.dto';
import { JwtAuthGuard } from '@infrastructure/auth/jwt-auth.guard';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { ROLES_KEY } from '@infrastructure/auth/roles.decorator';

describe('ScimTokenController', () => {
  // AuthModule registers JwtAuthGuard and RolesGuard globally; declaring them again on the
  // controller ran the token check twice per request (two EMERGENCY_ACCESS audit rows for a
  // break-glass request, two database reads).
  it('is for super-admins only, behind the global JWT and role guards only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ScimTokenController)).toEqual(['super-admin']);
    const declared = Reflect.getMetadata(GUARDS_METADATA, ScimTokenController) ?? [];
    expect(declared).not.toContain(JwtAuthGuard);
    expect(declared).not.toContain(RolesGuard);
  });

  it('mints a token for the signed-in admin and answers its plaintext with its id and name', async () => {
    const service = {
      generateToken: jest
        .fn()
        .mockResolvedValue({ id: 't1', name: 'Okta', token: 'plain-token', tokenHash: 'h' }),
    };
    const controller = new ScimTokenController(service as unknown as ScimTokenService);
    const body = {
      name: 'Okta',
      scopes: ['Users:read'],
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdBy: 'someone-else',
    } as CreateScimTokenDto;

    await expect(controller.create(body, { sub: 'admin-1' })).resolves.toEqual({
      id: 't1',
      name: 'Okta',
      token: 'plain-token',
    });
    expect(service.generateToken).toHaveBeenCalledWith(
      'Okta',
      'admin-1',
      ['Users:read'],
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  // The guard compares scopes exactly (hunt 2026-11-25, 02 F2): a scope no route checks would
  // mint a token that can do nothing, or one an admin believes limits it
  it('refuses a scope name the SCIM routes do not check', () => {
    expect(CreateScimTokenSchema.safeParse({ name: 'Okta', scopes: ['users:write'] }).success).toBe(
      false,
    );
    expect(CreateScimTokenSchema.safeParse({ name: 'Okta', scopes: ['Groups:read'] }).success).toBe(
      true,
    );
  });

  // Hunt 2026-11-25 (02 F13): an id that is no ObjectId reached findByIdAndUpdate and answered
  // 500 (CastError); it is now a 400 before any query
  it('checks the id of a revoke is an ObjectId', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ScimTokenController, 'revoke') as Record<
      string,
      { pipes: unknown[] }
    >;

    expect(Object.values(args).some((arg) => arg.pipes.includes(ParseObjectIdPipe))).toBe(true);
  });
});
