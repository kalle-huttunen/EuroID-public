/**
 * The worker logs through the API's winston configuration, so piiRedactFormat redacts the PII keys
 * of a log call made in an activity (plan 2.0dn). Before, the worker's context had Nest's default
 * console logger and printed them in clear.
 */
import { Logger, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { DefaultLogger } from '@temporalio/worker';
import { createWorkerContext } from './worker-context';

@Module({})
class EmptyModule {}

/**
 * Collects what reaches stdout: Nest's console logger writes to process.stdout, winston's Console
 * transport to the console's own stream (console._stdout, a buffer under Jest).
 */
function captureStdout(): string[] {
  const out: string[] = [];
  type Writable = { write: (chunk: string) => boolean };
  const consoleStream = (console as unknown as { _stdout?: Writable })._stdout;
  for (const stream of new Set([process.stdout as unknown as Writable, consoleStream])) {
    if (!stream) continue;
    jest.spyOn(stream, 'write').mockImplementation((chunk: string) => {
      out.push(String(chunk));
      return true;
    });
  }
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  return out;
}

describe('createWorkerContext', () => {
  let app: INestApplicationContext | undefined;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  it('logs an activity log call through winston with its PII keys redacted', async () => {
    const out = captureStdout();

    app = await createWorkerContext(EmptyModule);
    new Logger('EntraActivities').log({
      message: 'Provisioning user to Entra ID',
      email: 'ada.lovelace@example.com',
      mobilePhone: '+358 40 123 4567',
    });

    const printed = out.join('');
    expect(printed).toContain('Provisioning user to Entra ID');
    expect(printed).toContain('[REDACTED]');
    expect(printed).not.toContain('ada.lovelace@example.com');
    expect(printed).not.toContain('123 4567');
  });

  // worker.ts installs no Temporal runtime logger: the worker's own lines (polling, task
  // failures, workflow log.*) keep going through Temporal's default logger to stderr.
  it("leaves Temporal's own default logger printing", async () => {
    const errors: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });

    app = await createWorkerContext(EmptyModule);
    new DefaultLogger('INFO').warn('Activity task failed', { activityType: 'provisionUser' });

    expect(errors.join('\n')).toContain('Activity task failed');
  });
});
