/**
 * Every activity a workflow schedules must be registered on the task queue it is scheduled on.
 * A workflow's proxyActivities call compiles against the activity class, so a missing entry in
 * worker-default-activities.ts or in a connector manifest only shows at run time: the activity
 * task fails as an unregistered type and the run retries it forever (access request
 * expireBeforeFulfilment was missing this way).
 *
 * The test reads the workflow sources: for every proxyActivities call it takes the task queue
 * from its options (QUEUE_NAMES[...] or none, the default queue) and the activity names from
 * what the workflow reads off the proxy (destructured names, `proxy.name` accesses, or the type
 * argument's properties where the proxy is only reached indirectly). It then checks those names
 * against the activity maps worker.ts registers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { buildDefaultActivities } from './worker-default-activities';
import { registerBuiltInConnectors } from './modules/connectors/plugin/register-connectors';
import type { PluginRegistryService } from './modules/connectors/plugin/plugin-registry.service';
import type { ConnectorManifest } from './modules/connectors/plugin/connector-manifest.interface';
import { accessReviewRevocationQueueActivities } from './activities/access-review-revocation.activities';
import { moverAccessQueueActivities } from './activities/mover-access.activities';
import {
  DEFAULT_PROVISIONING_QUEUE,
  QUEUE_NAMES,
} from './infrastructure/temporal/task-queue.config';

const WORKFLOWS_DIR = path.join(__dirname, 'workflows');

/**
 * Proxies reached through a selector (getProvisionProxy, getHealthProxy) and called by a method
 * name built at run time: check<System>Health and provisionUserTo<System>. Those names are
 * checked below (BUILT_NAMES) and, for the default queue, by worker-default-activities.spec.ts.
 */
const DYNAMIC_PROXIES = new Set([
  'onboarding-health-check.ts:defaultHealthProxy',
  'onboarding-health-check.ts:entraHealthProxy',
  'onboarding-health-check.ts:adHealthProxy',
  'onboarding.workflow.ts:entraProxy',
  'onboarding.workflow.ts:adProxy',
  'onboarding.workflow.ts:defaultConnectorProxy',
  'admin-account-provisioning.workflow.ts:entraProxy',
  'admin-account-provisioning.workflow.ts:adProxy',
  'admin-account-provisioning.workflow.ts:defaultConnectorProxy',
  'mover.workflow.ts:entraProxy',
  'mover.workflow.ts:adProxy',
]);

/** The run-time names the Entra ID and AD selectors reach (getHealthMethodName and others). */
const BUILT_NAMES: Array<{ queue: string; name: string }> = [
  { queue: QUEUE_NAMES['entra'], name: 'checkEntraHealth' },
  { queue: QUEUE_NAMES['entra'], name: 'provisionUserToEntra' },
  { queue: QUEUE_NAMES['ad'], name: 'checkAdHealth' },
  { queue: QUEUE_NAMES['ad'], name: 'provisionUserToAd' },
];

/** A stub activity instance per context key; every method is a function. */
function stubContext<T>(): T {
  const method = new Proxy({}, { get: () => () => undefined });
  return new Proxy({}, { get: () => method }) as T;
}

interface Scheduled {
  file: string;
  queue: string;
  name: string;
}

function workflowSources(): ts.Program {
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => path.join(WORKFLOWS_DIR, f));
  // noResolve: imported activity classes stay unresolved, which is enough for Pick<...> and
  // inline type literals, and keeps the scan fast
  return ts.createProgram(files, {
    noResolve: true,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
  });
}

/** The const object literal a name refers to in the same file. */
function constObject(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The task queue of a proxyActivities call's options. */
function queueOf(sf: ts.SourceFile, options: ts.Expression | undefined, where: string): string {
  return (options && taskQueueIn(sf, options, where)) ?? DEFAULT_PROVISIONING_QUEUE;
}

/** The taskQueue an options object sets (spreads included), if any. */
function taskQueueIn(sf: ts.SourceFile, options: ts.Expression, where: string): string | undefined {
  const object = ts.isIdentifier(options) ? constObject(sf, options.text) : options;
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${where}: cannot read the options of proxyActivities`);
  }
  let queue: string | undefined;
  for (const prop of object.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (!ts.isIdentifier(prop.expression)) throw new Error(`${where}: unknown options spread`);
      queue = taskQueueIn(sf, prop.expression, where) ?? queue;
    } else if (prop.name && ts.isIdentifier(prop.name) && prop.name.text === 'taskQueue') {
      const value = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
      if (
        !value ||
        !ts.isElementAccessExpression(value) ||
        value.expression.getText(sf) !== 'QUEUE_NAMES' ||
        !ts.isStringLiteral(value.argumentExpression) ||
        !QUEUE_NAMES[value.argumentExpression.text]
      ) {
        throw new Error(`${where}: taskQueue must be QUEUE_NAMES['<connector>'] for this test`);
      }
      queue = QUEUE_NAMES[value.argumentExpression.text];
    }
  }
  return queue;
}

/** Names the workflow reads off a proxy held in a module-level variable. */
function namesReadOff(
  sf: ts.SourceFile,
  variable: string,
  seen = new Set<string>(),
): { names: string[]; dynamic: boolean } {
  seen.add(variable);
  /** `const alias = variable` or `const alias = cond ? variable : other`: follow the alias. */
  const aliasOf = (node: ts.Node): string | undefined => {
    let up = node.parent;
    if (ts.isConditionalExpression(up) && up.condition !== node) up = up.parent;
    if (ts.isVariableDeclaration(up) && up.initializer && ts.isIdentifier(up.name)) {
      return seen.has(up.name.text) ? undefined : up.name.text;
    }
    return undefined;
  };
  const names: string[] = [];
  let dynamic = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === variable && node.parent) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        names.push(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        if (ts.isStringLiteral(parent.argumentExpression)) {
          names.push(parent.argumentExpression.text);
        } else {
          dynamic = true;
        }
      } else if (aliasOf(node)) {
        const alias = namesReadOff(sf, aliasOf(node) as string, seen);
        names.push(...alias.names);
        dynamic = dynamic || alias.dynamic;
      } else if (!(ts.isVariableDeclaration(parent) && parent.name === node)) {
        // passed on, aliased or returned: the reader cannot be followed
        dynamic = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { names, dynamic };
}

/** Properties of proxyActivities' type argument (Pick<...> or an inline type literal). */
function typeArgumentNames(checker: ts.TypeChecker, call: ts.CallExpression): string[] {
  const arg = call.typeArguments?.[0];
  if (!arg) return [];
  return checker
    .getTypeFromTypeNode(arg)
    .getProperties()
    .map((p) => p.name);
}

function scheduledActivities(): Scheduled[] {
  const program = workflowSources();
  const checker = program.getTypeChecker();
  const out: Scheduled[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(WORKFLOWS_DIR)) continue;
    const file = path.basename(sf.fileName);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'proxyActivities'
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const where = `${file}:${line + 1}`;
        const queue = queueOf(sf, node.arguments[0], where);
        const add = (name: string) => out.push({ file, queue, name });
        const holder = node.parent;
        if (ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)) {
          for (const el of holder.name.elements) {
            const key = el.propertyName ?? el.name;
            if (!ts.isIdentifier(key)) throw new Error(`${where}: computed destructuring`);
            add(key.text);
          }
        } else if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
          const variable = holder.name.text;
          const read = namesReadOff(sf, variable);
          read.names.forEach(add);
          if (read.dynamic && !DYNAMIC_PROXIES.has(`${file}:${variable}`)) {
            const typed = typeArgumentNames(checker, node);
            if (typed.length === 0) {
              throw new Error(
                `${where}: ${variable} is used indirectly; give proxyActivities a Pick<...> type`,
              );
            }
            typed.forEach(add);
          }
          if (DYNAMIC_PROXIES.has(`${file}:${variable}`)) {
            BUILT_NAMES.filter((b) => b.queue === queue).forEach((b) => add(b.name));
          }
        } else {
          // held in an object literal (per-connector proxies) or passed on
          const typed = typeArgumentNames(checker, node);
          if (typed.length === 0) {
            throw new Error(`${where}: cannot tell which activities this proxy schedules`);
          }
          typed.forEach(add);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

const manifests: ConnectorManifest[] = [];
registerBuiltInConnectors({
  register: (manifest: ConnectorManifest) => manifests.push(manifest),
} as unknown as PluginRegistryService);

/** The activity names worker.ts registers per task queue. */
function registeredByQueue(): Map<string, Set<string>> {
  const registered = new Map<string, Set<string>>();
  registered.set(
    DEFAULT_PROVISIONING_QUEUE,
    new Set(Object.keys(buildDefaultActivities(stubContext()))),
  );
  const extras = [
    accessReviewRevocationQueueActivities(stubContext()),
    moverAccessQueueActivities(stubContext()),
  ];
  for (const manifest of manifests) {
    if (!manifest.taskQueue || !manifest.activityClass || !manifest.activityBindings) continue;
    const names = new Set(Object.keys(manifest.activityBindings));
    for (const extra of extras)
      Object.keys(extra[manifest.taskQueue] ?? {}).forEach((n) => names.add(n));
    registered.set(manifest.taskQueue, names);
  }
  return registered;
}

describe('activities scheduled by the workflows', () => {
  const scheduled = scheduledActivities();
  const registered = registeredByQueue();

  it('finds the proxies of every workflow (the scan works)', () => {
    expect(scheduled.length).toBeGreaterThan(100);
    expect(scheduled).toContainEqual({
      file: 'access-request-approval.workflow.ts',
      queue: DEFAULT_PROVISIONING_QUEUE,
      name: 'expireBeforeFulfilment',
    });
    expect(scheduled).toContainEqual({
      file: 'mover-access.ts',
      queue: QUEUE_NAMES['entra'],
      name: 'applyMoverAccess',
    });
  });

  it('are all registered on the task queue they are scheduled on', () => {
    const missing = scheduled
      .filter(({ queue, name }) => !registered.get(queue)?.has(name))
      .map(({ file, queue, name }) => `${file}: ${name} on ${queue}`);
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("bind each connector queue name to a method of the manifest's activity class", () => {
    const unbound: string[] = [];
    for (const manifest of manifests) {
      if (!manifest.taskQueue || !manifest.activityClass || !manifest.activityBindings) continue;
      const proto = manifest.activityClass.prototype as Record<string, unknown>;
      for (const [name, method] of Object.entries(manifest.activityBindings)) {
        if (typeof proto[method] !== 'function') unbound.push(`${manifest.taskQueue}: ${name}`);
      }
    }
    expect(unbound).toEqual([]);
  });
});
