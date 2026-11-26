/**
 * Jest globalSetup of both backend configs: one in-memory MongoDB for the whole run. Every suite
 * takes its own database on it through src/testing/test-db.ts (testDbUri, connectTestDb,
 * closeTestDb). Jest starts the test workers after this runs, so they inherit TEST_MONGO_URI.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

/** The prefix mongodb-memory-server gives a server's directory in the temp dir (11.x). */
const DIR_PREFIX = 'mongo-mem-';
/**
 * A directory without `mongod.lock` this old is a crashed run's: mongodb-memory-server makes the
 * directory before it starts mongod, and a first run may download the binary meanwhile.
 */
const NO_LOCK_STALE_AFTER_MS = 60 * 60 * 1000;
/** mongod creates its lock and then writes its PID: an empty lock younger than this may be a start. */
const EMPTY_LOCK_GRACE_MS = 60 * 1000;

export default async function mongoGlobalSetup(): Promise<void> {
  const removed = removeStaleMongoDirs(os.tmpdir(), Date.now());
  if (removed.length > 0) {
    const mb = removed.reduce((sum, r) => sum + r.bytes, 0) / (1024 * 1024);
    console.log(
      `mongo-global-setup: removed ${removed.length} directories crashed runs left ` +
        `(${mb.toFixed(1)} MB): ${removed.map((r) => r.path).join(', ')}`,
    );
  }
  // The default launch timeout (10 s) failed whole suites on a loaded machine
  const mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  process.env.TEST_MONGO_URI = mongod.getUri();
  // globalTeardown runs in this process and stops it
  (globalThis as { __testMongod?: MongoMemoryServer }).__testMongod = mongod;
}

/** True unless no process has this PID (ESRCH). Another user's process (EPERM) counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Bytes of the files under `p`, links not followed. */
function sizeOf(p: string): number {
  const stat = fs.lstatSync(p);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(p).reduce((sum, entry) => sum + sizeOf(path.join(p, entry)), 0);
}

/**
 * Whether the mongod of a mongodb-memory-server directory is gone. A running mongod keeps its PID
 * in `mongod.lock` and empties the lock when it stops cleanly; a killed one leaves its PID there.
 */
function mongodGone(
  dir: string,
  dirMtimeMs: number,
  now: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const lockPath = path.join(dir, 'mongod.lock');
  let lock: string;
  let lockMtimeMs: number;
  try {
    lock = fs.readFileSync(lockPath, 'utf8').trim();
    lockMtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false; // unreadable: keep it
    return now - dirMtimeMs >= NO_LOCK_STALE_AFTER_MS;
  }
  if (lock === '') return now - lockMtimeMs >= EMPTY_LOCK_GRACE_MS;
  if (!/^\d+$/.test(lock)) return false;
  return !isAlive(Number(lock));
}

/**
 * Remove the mongodb-memory-server directories (`mongo-mem-*` in tmpDir) that crashed runs left
 * behind: owned by this user and their mongod gone (mongodGone). A directory a live mongod uses
 * is never removed, whoever started it. Returns each removed path with its size in bytes.
 */
export function removeStaleMongoDirs(
  tmpDir: string,
  now: number,
  isAlive: (pid: number) => boolean = pidAlive,
): { path: string; bytes: number }[] {
  const removed: { path: string; bytes: number }[] = [];
  for (const entry of fs.readdirSync(tmpDir)) {
    if (!entry.startsWith(DIR_PREFIX)) continue;
    const dir = path.join(tmpDir, entry);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.()) continue;
      if (!mongodGone(dir, stat.mtimeMs, now, isAlive)) continue;
      const bytes = sizeOf(dir);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push({ path: dir, bytes });
    } catch (err) {
      console.warn(`mongo-global-setup: could not remove ${dir}: ${err}`);
    }
  }
  return removed;
}
