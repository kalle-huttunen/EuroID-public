import { ForbiddenException } from '@nestjs/common';
import { assertFirstAdminSetupAllowed, SETUP_TOKEN_MISSING_MESSAGE } from './first-admin-setup';

/**
 * The first registration of a deployment becomes its super-admin. Outside development and test
 * nobody may take that before the owner: it needs SETUP_TOKEN, and without one it is refused.
 */
describe('assertFirstAdminSetupAllowed', () => {
  it.each(['production', 'staging', 'pre-prod', ''])(
    'refuses the setup when SETUP_TOKEN is not set and NODE_ENV is %p',
    (nodeEnv) => {
      expect(() => assertFirstAdminSetupAllowed({ nodeEnv, provided: 'anything' })).toThrow(
        SETUP_TOKEN_MISSING_MESSAGE,
      );
    },
  );

  it.each(['development', 'test'])('leaves the setup open without SETUP_TOKEN in %s', (nodeEnv) => {
    expect(() => assertFirstAdminSetupAllowed({ nodeEnv })).not.toThrow();
  });

  it('needs the exact SETUP_TOKEN when one is set, in every environment', () => {
    for (const nodeEnv of ['production', 'development']) {
      const allowed = (provided?: string) =>
        assertFirstAdminSetupAllowed({ nodeEnv, setupToken: 's3tup-T0ken', provided });
      expect(() => allowed('s3tup-T0ken')).not.toThrow();
      for (const wrong of [undefined, '', 's3tup-T0ke', 's3tup-T0ken ', 'S3TUP-T0KEN']) {
        expect(() => allowed(wrong)).toThrow(ForbiddenException);
      }
    }
  });
});
