/**
 * Jest globalTeardown of both backend configs: stop the run's in-memory MongoDB (started by
 * mongo-global-setup.ts) and remove its directory, so a finished run leaves nothing in the
 * temp directory. A crashed run's directory is removed by the next run's setup.
 */
import type { MongoMemoryServer } from 'mongodb-memory-server';

export default async function mongoGlobalTeardown(): Promise<void> {
  const mongod = (globalThis as { __testMongod?: MongoMemoryServer }).__testMongod;
  await mongod?.stop({ doCleanup: true });
}
