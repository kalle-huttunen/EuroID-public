/**
 * Every workflow worker.ts starts on a Temporal schedule is exported from workflows/index.ts, the
 * module the worker bundles (src/workflows in development, dist/src/workflows for
 * workflow-bundle.js in production). A schedule starts its workflow by type name, and a type the
 * bundle does not export starts on schedule and never runs: recertificationSchedulerWorkflow,
 * intelligenceBatchWorkflow and auditArchiveWorkflow were scheduled and missing, so the daily
 * recertification, intelligence batch and audit archive never ran.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as scheduled from './worker-scheduled-workflows';
import * as workflows from './workflows';

describe('the workflows worker.ts schedules', () => {
  it('are each exported from workflows/index.ts under the type name a schedule starts', () => {
    const exported = workflows as Record<string, unknown>;
    const entries = Object.entries(scheduled);
    expect(entries.length).toBeGreaterThan(0);

    const missing = entries
      .filter(([, workflow]) => exported[workflow.name] !== workflow)
      .map(([name]) => name);

    expect(missing).toEqual([]);
  });

  // So the check above covers every schedule worker.ts creates
  it('are all taken from worker-scheduled-workflows.ts by worker.ts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'worker.ts'), 'utf8');
    // Each schedule is ensureSchedule(id, cron, scheduled.<workflow>, ...), or optionalSchedule
    // with the same first arguments for a job an env variable turns on (schedule-upsert.ts)
    const calls = source.match(/(?:ensureSchedule|optionalSchedule)\(/g) ?? [];
    const startedTypes = [
      ...source.matchAll(
        /(?:ensureSchedule|optionalSchedule)\(\s*'[^']+',\s*[^,]+,\s*scheduled\.(\w+)/g,
      ),
    ].map((m) => m[1]);

    expect(source).not.toMatch(/import\(\s*['"]\.\/workflows\//);
    expect(source).not.toMatch(/schedule\.create\(/);
    expect(startedTypes).toHaveLength(calls.length);
    expect(startedTypes.sort()).toEqual(Object.keys(scheduled).sort());
  });
});
