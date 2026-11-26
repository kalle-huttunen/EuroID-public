import { basename, resolve } from 'path';

/**
 * The backend/ directory from the directory main.ts runs in: backend/src under ts-node,
 * backend/dist/src when built. The .env lookup and the root swagger-spec.json path start here,
 * so a built API does not write the spec into backend/.
 */
export function backendRootOf(mainDir: string): string {
  const parent = resolve(mainDir, '..');
  return basename(parent) === 'dist' ? resolve(parent, '..') : parent;
}
