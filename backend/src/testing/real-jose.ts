/**
 * The real `jose`, for a spec that tests what a token check refuses. jest.config.ts maps 'jose'
 * to the CommonJS stand-in `__mocks__/jose.ts` (jose is ESM only), which checks the signature,
 * issuer and audience but never `exp`, `nbf` or `alg`. Use it in a mock factory:
 *
 *   jest.mock('jose', () => jest.requireActual('@testing/real-jose').loadRealJose());
 *
 * Node's own `require` loads the ESM build (require(esm), Node 22.12 and later) outside Jest's
 * module registry; Jest's `require('module').createRequire` would resolve to the stand-in again.
 */
export function loadRealJose(): typeof import('jose') {
  return process.getBuiltinModule('node:module').createRequire(__filename)('jose');
}
