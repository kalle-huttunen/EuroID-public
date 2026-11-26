/**
 * The NODE_ENV values that allow development conveniences: AUTH_DISABLED, the dev tools routes,
 * a first-admin setup without SETUP_TOKEN, Swagger UI, auth cookies without `secure`, unsigned
 * SAML assertions and SAML user creation by default. An allow-list: every other value, an unset
 * NODE_ENV and `staging` or `pre-prod` included, gets the production rules.
 */
export const DEV_OR_TEST_NODE_ENVS: readonly string[] = ['development', 'test'];

/** Whether `nodeEnv` (process.env.NODE_ENV by default) is development or test. */
export function isDevOrTest(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== undefined && DEV_OR_TEST_NODE_ENVS.includes(nodeEnv);
}
