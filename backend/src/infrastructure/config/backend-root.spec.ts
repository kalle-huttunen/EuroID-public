import { resolve } from 'path';
import { backendRootOf } from './backend-root';

describe('backendRootOf', () => {
  const backend = resolve('/repo', 'backend');

  it('finds backend/ from src/ (ts-node, start:dev)', () => {
    expect(backendRootOf(resolve(backend, 'src'))).toBe(backend);
  });

  it('finds backend/ from dist/src/ (built API), so the spec lands in the repo root', () => {
    expect(backendRootOf(resolve(backend, 'dist', 'src'))).toBe(backend);
    expect(resolve(backendRootOf(resolve(backend, 'dist', 'src')), '..', 'swagger-spec.json')).toBe(
      resolve('/repo', 'swagger-spec.json'),
    );
  });
});
