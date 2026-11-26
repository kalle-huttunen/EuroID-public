/**
 * migrate-mongo configuration
 *
 * Reads MONGO_URI from environment (Safety Rule #9: no hardcoded URLs).
 * Migration files live in ./migrations/ as TypeScript.
 * Tracking collection: migration_changelog.
 */
import 'dotenv/config';

const config = {
  mongodb: {
    url: process.env.MONGO_URI || 'mongodb://localhost:27017/euroid',
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migration_changelog',
  migrationFileExtension: '.ts',
  useFileHash: false,
};

export = config;
