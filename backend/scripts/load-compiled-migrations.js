/**
 * Run migrate-mongo on the compiled migrations, under the migrations' TypeScript names.
 *
 * migrate-mongo records each applied migration in migration_changelog by its file name,
 * extension included (`20260222000000-baseline.ts`, as `npm run migrate:up` applies them through
 * ts-node). The API image has no ts-node and no `src/`, so it cannot load the `.ts` files, but
 * `nest build` compiles them, and migrate-mongo-config.ts, into `dist/` (path aliases rewritten to
 * relative paths, as for dist/src/main.js). Preloaded with `node -r`, this file makes a `.ts` file
 * under the backend directory load as its compiled twin under `dist/` (`migrations/X.ts` ->
 * `dist/migrations/X.js`). migrate-mongo still lists `migrations/*.ts`, so the names it reads
 * and writes stay the `.ts` ones and a database migrated in development is recognised.
 *
 * Used by `npm run migrate:up:dist` (the API image's CMD), `migrate:status:dist` and
 * `migrate:down:dist`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

require.extensions['.ts'] = (module, filename) => {
  const relative = path.relative(root, filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${filename} is outside ${root}: no compiled file to load`);
  }
  const compiled = path.join(dist, relative.replace(/\.ts$/, '.js'));
  if (!fs.existsSync(compiled)) {
    throw new Error(`${filename} has no compiled ${compiled}: run npm run build`);
  }
  // Loaded as a module of its own, so its relative requires resolve inside dist/
  module.exports = require(compiled);
};
