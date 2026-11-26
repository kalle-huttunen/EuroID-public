/**
 * Every DomainEventEmitterService call in backend/src (emit, emitAndWait, emitWithTransaction)
 * whose event type has a payload schema in EVENT_SCHEMAS passes only keys that schema knows and
 * every key it requires. The emitter parses the payload with the schema: zod strips an unknown key
 * before any handler, the audit log or the websocket sees it, and a missing required key throws
 * outside production and dead-letters the event in production.
 *
 * Plan 2.0du: the write-back's identity.updated had no changedFields (the write-back activity
 * failed after its write), and policy.updated lost previousStatus.
 *
 * What it reads: the source, with the TypeScript parser and no type checker. The event type is a
 * DomainEventType member (or a `cond ? A : B` of two). The payload keys are those of the object
 * literal written in the call or in a `const` of the same function, `name.key = ...` assignments
 * to that const, and object literals spread into it (`...(cond ? { key } : {})`).
 *
 * What it does not check: value types and enum values (the emitter checks them at runtime), and
 * required keys of a payload that spreads another object (`...outcome`): its explicit keys are
 * still checked. A call whose event type or payload it cannot read is listed in NOT_READABLE with
 * the reason; a new one fails the test until it is listed there or written so the guard reads it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { z } from 'zod';
import { EVENT_SCHEMAS } from './event-payload-schemas';
import { DomainEventType } from './event-types';

const SRC = path.resolve(__dirname, '../..');
const EMIT_METHODS = new Set(['emit', 'emitAndWait', 'emitWithTransaction']);
const MAY_EMIT = /\.(emit|emitAndWait|emitWithTransaction)\s*[<(]/;

/** Calls the guard cannot read, as "path under src|first argument": why that is acceptable. */
const NOT_READABLE: Record<string, string> = {
  'modules/identity/identity-sync-run.ts|type':
    'startRun forwards its type and payload parameters. Its callers in the same file build the ' +
    'identity.move_requested and identity.provision_requested payloads, which ' +
    'identity-sync-to-entra.spec sends through the real emitter.',
  'activities/entitlement-expiry.activities.ts|WARNINGS[window].event':
    'The type is looked up per warning window: entitlement.expiring_soon or ' +
    'entitlement.expiring_tomorrow, which share one schema; event-payload-schemas.spec sends ' +
    "the activity's payload through it.",
  'modules/connectors/hr-ingestion.service.ts|DomainEventType.HR_SYNC_COMPLETED':
    'The payload is a parameter typed HrSyncCompletedPayload.',
  'modules/connectors/hr-ingestion.service.ts|DomainEventType.HR_SYNC_MOVERS_REQUESTED':
    'The payload is a parameter typed HrSyncCompletedPayload.',
  'modules/connectors/hr-ingestion.service.ts|DomainEventType.HR_SYNC_JOINERS_REQUESTED':
    'The payload is a parameter typed HrSyncCompletedPayload.',
};

interface EmitCall {
  /** path under src:line */
  at: string;
  /** "path under src|first argument", the NOT_READABLE key */
  key: string;
  /** null: not a DomainEventType member the guard can read */
  types: string[] | null;
  /** null: no object literal the guard can read */
  keys: string[] | null;
  /** The payload spreads an object the guard cannot read: required keys are not checked. */
  opaqueSpread: boolean;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function eventTypes(node: ts.Expression): string[] | null {
  const n = unwrap(node);
  if (ts.isConditionalExpression(n)) {
    const a = eventTypes(n.whenTrue);
    const b = eventTypes(n.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isPropertyAccessExpression(n) && n.expression.getText() === 'DomainEventType') {
    const value = (DomainEventType as Record<string, string>)[n.name.text];
    return value ? [value] : null;
  }
  return null;
}

/** Keys of an object literal; spreads of literals (also `cond ? {..} : {..}`) add theirs. */
function literalKeys(obj: ts.ObjectLiteralExpression): { keys: string[]; opaqueSpread: boolean } {
  const keys: string[] = [];
  let opaqueSpread = false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const spread = unwrap(prop.expression);
      const parts = ts.isConditionalExpression(spread)
        ? [unwrap(spread.whenTrue), unwrap(spread.whenFalse)]
        : [spread];
      for (const part of parts) {
        if (ts.isObjectLiteralExpression(part)) {
          const inner = literalKeys(part);
          keys.push(...inner.keys);
          opaqueSpread ||= inner.opaqueSpread;
        } else {
          opaqueSpread = true;
        }
      }
    } else if (prop.name && !ts.isComputedPropertyName(prop.name)) {
      keys.push((prop.name as ts.Identifier | ts.StringLiteral | ts.NumericLiteral).text);
    } else {
      opaqueSpread = true;
    }
  }
  return { keys, opaqueSpread };
}

/** The object literal a variable is declared with before the call, and its enclosing block. */
function constLiteral(
  name: string,
  call: ts.CallExpression,
): { literal: ts.ObjectLiteralExpression; scope: ts.Node } | null {
  for (let scope: ts.Node | undefined = call.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (statement.pos >= call.pos || !ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer && unwrap(decl.initializer);
        if (ts.isIdentifier(decl.name) && decl.name.text === name && init) {
          return ts.isObjectLiteralExpression(init) ? { literal: init, scope } : null;
        }
      }
    }
  }
  return null;
}

function payloadKeys(
  node: ts.Expression,
  call: ts.CallExpression,
): { keys: string[] | null; opaqueSpread: boolean } {
  const n = unwrap(node);
  if (ts.isObjectLiteralExpression(n)) return literalKeys(n);
  if (!ts.isIdentifier(n)) return { keys: null, opaqueSpread: false };
  const found = constLiteral(n.text, call);
  if (!found) return { keys: null, opaqueSpread: false };
  const read = literalKeys(found.literal);
  found.scope.forEachChild(function assigned(child: ts.Node): void {
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(child.left) &&
      ts.isIdentifier(child.left.expression) &&
      child.left.expression.text === n.text
    ) {
      read.keys.push(child.left.name.text);
    }
    child.forEachChild(assigned);
  });
  return read;
}

/** The emit calls in one source file. */
function findEmitCalls(relPath: string, text: string): EmitCall[] {
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const calls: EmitCall[] = [];
  source.forEachChild(function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EMIT_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 3
    ) {
      const [typeArg, , payloadArg] = node.arguments;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      calls.push({
        at: `${relPath}:${line}`,
        key: `${relPath}|${typeArg.getText().replace(/\s+/g, ' ')}`,
        types: eventTypes(typeArg),
        ...payloadKeys(payloadArg, node),
      });
    }
    node.forEachChild(visit);
  });
  return calls;
}

/** Keys a schema would strip and required keys it would reject the payload for. */
function mismatches(call: EmitCall): string[] {
  const problems: string[] = [];
  for (const type of call.types ?? []) {
    const schema = EVENT_SCHEMAS[type as DomainEventType];
    if (!schema || !call.keys) continue;
    if (!(schema instanceof z.ZodObject)) {
      problems.push(`${call.at} ${type}: schema is not a z.object, the guard cannot read it`);
      continue;
    }
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    for (const key of call.keys) {
      if (!(key in shape)) problems.push(`${call.at} ${type}: '${key}' is not in the schema`);
    }
    if (call.opaqueSpread) continue;
    for (const [key, field] of Object.entries(shape)) {
      if (!field.isOptional() && !call.keys.includes(key)) {
        problems.push(`${call.at} ${type}: required '${key}' is missing`);
      }
    }
  }
  return problems;
}

/** Calls whose event type the guard cannot read, or whose payload when the event has a schema. */
function unreadable(call: EmitCall): boolean {
  if (call.types === null) return true;
  return call.keys === null && call.types.some((t) => EVENT_SCHEMAS[t as DomainEventType]);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/(?<!\.spec|\.d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('emitted event payloads against their zod schemas', () => {
  const calls = sourceFiles(SRC).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return MAY_EMIT.test(text) ? findEmitCalls(path.relative(SRC, file), text) : [];
  });

  it('reports a key the schema strips and a required key the payload lacks', () => {
    const source = [
      'class Fixture {',
      '  run(id: string, flag: boolean) {',
      '    this.events.emit(DomainEventType.POLICY_UPDATED, id, { policyId: id, extra: 1 });',
      '    const payload = { identityId: id, source: "x", ...(flag ? { email: "a" } : {}) };',
      '    payload.more = 1;',
      '    this.events.emit(DomainEventType.IDENTITY_UPDATED, id, payload, { depth: 1 });',
      '    this.events.emit(',
      '      flag ? DomainEventType.NHI_REVOKED : DomainEventType.NHI_KILL_SWITCH_ENGAGED,',
      '      id,',
      '      { agentId: id, reason: "r", killSwitch: flag },',
      '    );',
      '  }',
      '}',
    ].join('\n');

    const found = findEmitCalls('fixture.ts', source);

    expect(found.flatMap(mismatches)).toEqual([
      "fixture.ts:3 policy.updated: 'extra' is not in the schema",
      "fixture.ts:3 policy.updated: required 'changedFields' is missing",
      // identity.updated has no email since plan 2.0dn
      "fixture.ts:6 identity.updated: 'email' is not in the schema",
      "fixture.ts:6 identity.updated: 'more' is not in the schema",
      "fixture.ts:6 identity.updated: required 'changedFields' is missing",
    ]);
    expect(found[1].keys).toEqual(['identityId', 'source', 'email', 'more']);
    expect(found[2].types).toEqual(['nhi.revoked', 'nhi.kill_switch_engaged']);
  });

  it('finds the emit calls of backend/src', () => {
    // Over 60 calls with a schema when this was written: far fewer means the scan lost them
    const checked = calls.filter((c) => c.types?.some((t) => EVENT_SCHEMAS[t as DomainEventType]));
    expect(checked.length).toBeGreaterThanOrEqual(50);
  });

  it('passes only keys the schema knows and every key it requires', () => {
    expect(calls.flatMap(mismatches)).toEqual([]);
  });

  it('reads every emit call that has a schema, or lists why not', () => {
    const notListed = calls.filter((c) => unreadable(c) && !(c.key in NOT_READABLE));
    expect(notListed.map((c) => `${c.at} (${c.key})`)).toEqual([]);

    const unreadableKeys = new Set(calls.filter(unreadable).map((c) => c.key));
    const stale = Object.keys(NOT_READABLE).filter((key) => !unreadableKeys.has(key));
    expect(stale).toEqual([]);
  });
});
