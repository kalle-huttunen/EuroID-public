/**
 * In-memory MongoDB for integration tests: one server per jest run, a database per suite.
 * The jest configs' globalSetup (`test/mongo-global-setup.ts`) starts the server and sets
 * TEST_MONGO_URI; jest loads this module once per test file, so the names below are per suite.
 */
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';

/** The databases this suite was given; closeTestDb() drops them. */
const suiteDbNames = new Set<string>();
let suiteId: string | undefined;

function serverUri(): string {
  const uri = process.env.TEST_MONGO_URI;
  if (!uri) {
    throw new Error(
      'TEST_MONGO_URI is not set: run the spec through the backend jest configs, whose ' +
        'globalSetup (test/mongo-global-setup.ts) starts the in-memory MongoDB',
    );
  }
  return uri;
}

const randomHex = () => randomBytes(4).toString('hex');

/**
 * A database name unique to this suite: `t_<JEST_WORKER_ID>_<8 random hex>`, a new one on every
 * call. With a label, the same name for the same label within the suite, for a spec that works
 * with several named databases (the label stands in for a fixed name such as 'schema').
 */
export function testDbName(label?: string): string {
  const prefix = `t_${process.env.JEST_WORKER_ID ?? '0'}`;
  let name: string;
  if (label) {
    suiteId ??= randomHex();
    name = `${prefix}_${suiteId}_${label}`;
  } else {
    name = `${prefix}_${randomHex()}`;
  }
  suiteDbNames.add(name);
  return name;
}

/** The URI of a database unique to this suite on the run's server (see testDbName). */
export function testDbUri(label?: string): string {
  const server = serverUri().replace(/\/+$/, '');
  return `${server}/${testDbName(label)}`;
}

/**
 * Connect the default mongoose connection to a new database of this suite.
 * Call in beforeAll() of integration test suites.
 */
export async function connectTestDb(): Promise<string> {
  const uri = testDbUri();
  await mongoose.connect(uri);
  return uri;
}

/**
 * Drop all collections. Call in afterEach() to isolate tests.
 */
export async function clearTestDb(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}

/**
 * Close every mongoose connection, then drop the databases this suite was given. The server
 * stays up for the other suites. Call in afterAll().
 */
export async function closeTestDb(): Promise<void> {
  await mongoose.disconnect();
  const names = [...suiteDbNames];
  suiteDbNames.clear();
  if (names.length === 0) return;
  const connection = await mongoose.createConnection(serverUri()).asPromise();
  try {
    for (const name of names) {
      await connection.getClient().db(name).dropDatabase();
    }
  } finally {
    await connection.close();
  }
}
