/**
 * The soak load test (tests/load/k6-soak.js) reads an analytics route among its endpoints. It
 * called GET /analytics/dashboard, which the API does not have, so part of the soak load was 404s
 * and its latency and error figures were wrong. Each analytics path it calls, and the one its
 * README names, must be a GET route of the API (the generated OpenAPI spec).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(resolve(ROOT, file), 'utf8');

/** The `/analytics/...` paths quoted in `text`, without their query strings. */
const analyticsPaths = (text: string) =>
  [...text.matchAll(/[`'"]?(\/analytics\/[A-Za-z0-9/_-]+)/g)].map((m) => m[1]);

describe('the soak load test calls analytics routes the API has', () => {
  const spec = JSON.parse(read('swagger-spec.json')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const getRoute = (path: string) => spec.paths[`/api/v1${path}`]?.get !== undefined;

  it.each([['tests/load/k6-soak.js'], ['tests/load/README.md']])('%s', (file) => {
    const paths = analyticsPaths(read(file));

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !getRoute(path))).toEqual([]);
  });
});
