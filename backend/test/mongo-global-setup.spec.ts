import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pidAlive, removeStaleMongoDirs } from './mongo-global-setup';

/**
 * The run's setup removes the directories crashed runs left in the temp dir (each about 200 MB on
 * a tmpfs with a per-user quota), but never one a running mongod still uses: other worktrees run
 * their tests on the same machine. A running mongod keeps its PID in `mongod.lock` in its
 * directory and empties the lock when it stops cleanly; a killed one leaves its PID there.
 */
describe('removeStaleMongoDirs', () => {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const now = Date.now();
  const LIVE_PID = 4242;
  const DEAD_PID = 4343;
  const alive = (pid: number) => pid === LIVE_PID;
  let tmp: string;

  /** A mongo-mem-style directory with a 1000-byte data file, its lock and itself `ageMs` old. */
  const dir = (name: string, ageMs: number, lock?: string) => {
    const p = path.join(tmp, name);
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'WiredTiger.wt'), Buffer.alloc(1000));
    const time = new Date(now - ageMs);
    if (lock !== undefined) {
      fs.writeFileSync(path.join(p, 'mongod.lock'), lock);
      fs.utimesSync(path.join(p, 'mongod.lock'), time, time);
    }
    fs.utimesSync(p, time, time);
    return p;
  };
  const exists = (p: string) => fs.existsSync(p);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-mongo-spec-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("removes a directory whose mongod is gone and keeps a live mongod's, however old", () => {
    const killed = dir('mongo-mem-killed', 5 * MINUTE, `${DEAD_PID}\n`);
    const running = dir('mongo-mem-running', 3 * HOUR, `${LIVE_PID}\n`);

    const removed = removeStaleMongoDirs(tmp, now, alive);

    expect(removed.map((r) => r.path)).toEqual([killed]);
    expect(exists(killed)).toBe(false);
    expect(exists(running)).toBe(true);
  });

  it('removes a directory whose mongod stopped (empty lock), not one that is starting', () => {
    const stopped = dir('mongo-mem-stopped', 5 * MINUTE, '');
    // mongod creates the lock and then writes its PID: an empty lock just made may be a start
    const starting = dir('mongo-mem-starting', 10 * 1000, '');

    expect(removeStaleMongoDirs(tmp, now, alive).map((r) => r.path)).toEqual([stopped]);
    expect(exists(starting)).toBe(true);
  });

  // mongodb-memory-server makes the directory before it starts mongod (a first run may download
  // the binary meanwhile): without a lock only an hour-old directory is a crashed run's.
  it('removes a directory without a lock only when it is an hour old', () => {
    const neverStarted = dir('mongo-mem-never-started', 2 * HOUR);
    const preparing = dir('mongo-mem-preparing', 10 * MINUTE);

    expect(removeStaleMongoDirs(tmp, now, alive).map((r) => r.path)).toEqual([neverStarted]);
    expect(exists(preparing)).toBe(true);
  });

  it('keeps a directory whose lock cannot be read, and anything not named mongo-mem-*', () => {
    const unreadable = dir('mongo-mem-unreadable', 3 * HOUR);
    fs.mkdirSync(path.join(unreadable, 'mongod.lock')); // reading it fails with EISDIR
    const other = dir('jest_rs', 3 * HOUR, `${DEAD_PID}\n`);

    expect(removeStaleMongoDirs(tmp, now, alive)).toEqual([]);
    expect(exists(unreadable)).toBe(true);
    expect(exists(other)).toBe(true);
  });

  it('reports the size of what it removed', () => {
    dir('mongo-mem-killed', 5 * MINUTE, `${DEAD_PID}\n`);

    const [removed] = removeStaleMongoDirs(tmp, now, alive);

    // The data file and the lock
    expect(removed.bytes).toBe(1000 + `${DEAD_PID}\n`.length);
  });

  it('tells a running process from one that has exited', () => {
    const exited = spawnSync(process.execPath, ['-e', '0']).pid;

    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(exited)).toBe(false);
  });
});
