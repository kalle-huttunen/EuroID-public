/**
 * No log line in backend/src writes an email address in clear (plan 2.0dn). piiRedactFormat and
 * safeLog redact by key; the text of a message is not scanned, so a log line that names a person
 * puts the address through maskEmail or maskEmails itself (modules/identity/identity-pii.ts,
 * activities/deprovision-failure.ts).
 *
 * What it reads: every `logger.<level>(...)` call (any object ending in `logger`), and in workflow
 * code every `log.<level>(...)` call (Temporal's runtime logger from @temporalio/workflow, which
 * nothing redacts), with a template literal argument. A `${...}` whose value is a name that holds
 * an address (`email`, `user.email`, `drift.userEmail`, `identityIdOrEmail`, `targetEmail`, `upn`,
 * `userPrincipalName`, `mail`, an orphan's `accountIdentifier`) fails; a value that goes through a
 * call (`maskEmail(email)`) passes. Both sides of `a ?? b`, `a || b` and `c ? a : b` are read.
 *
 * What it does not read: other names that may hold an address (a SCIM `userName`, a UPN
 * `candidate`), and string concatenation.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.resolve(__dirname, '../..');
const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'verbose', 'trace']);
const ADDRESS_NAME = /email|^upn$|userprincipalname|^mail$|^accountidentifier$/i;

/** `this.logger`, `logger`, or a workflow's bare `log` (@temporalio/workflow). */
function isLogger(object: ts.Expression): boolean {
  return /logger$/i.test(object.getText()) || (ts.isIdentifier(object) && object.text === 'log');
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** The parts of a `${...}` value that reach the text: both sides of ??, || and ?:. */
function reaching(node: ts.Expression): ts.Expression[] {
  const n = unwrap(node);
  if (ts.isConditionalExpression(n)) return [...reaching(n.whenTrue), ...reaching(n.whenFalse)];
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...reaching(n.left), ...reaching(n.right)];
  }
  return [n];
}

function holdsAddress(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return ADDRESS_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return ADDRESS_NAME.test(node.name.text);
  return false;
}

/** "path:line ${value}" of each clear address in a logger template, and the templates read. */
function scan(relPath: string, text: string): { found: string[]; templates: number } {
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  let templates = 0;
  source.forEachChild(function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LEVELS.has(node.expression.name.text) &&
      isLogger(node.expression.expression)
    ) {
      for (const arg of node.arguments.filter(ts.isTemplateExpression)) {
        templates++;
        for (const span of arg.templateSpans) {
          if (reaching(span.expression).some(holdsAddress)) {
            const line = source.getLineAndCharacterOfPosition(span.getStart()).line + 1;
            found.push(`${relPath}:${line} \${${span.expression.getText()}}`);
          }
        }
      }
    }
    node.forEachChild(visit);
  });
  return { found, templates };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.isFile() && /(?<!\.spec|\.d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('log lines: no email address in clear', () => {
  it('reports an address name in a logger template, not one that goes through a call', () => {
    const source = [
      'class Fixture {',
      '  run(email: string, user: { email: string }, upn?: string, id?: string) {',
      '    this.logger.log(`Provisioning ${user.email} as ${maskEmail(email)}`);',
      '    this.logger.warn(`Delete ${upn ?? id}: ${id ? maskEmails(upn!) : "none"}`);',
      '    logger.error(`For ${identityIdOrEmail}`, `${String(email)}`);',
      '    this.log.info(`Not a logger ${email}`);',
      '  }',
      '}',
      'export async function someWorkflow(targetEmail: string, o: { accountIdentifier: string }) {',
      '  log.info(`Started for ${targetEmail || "all users"}`);',
      '  log.warn(`Orphan ${o.accountIdentifier}`, { id: targetEmail });',
      '  log.error(`Masked ${maskEmails(targetEmail)}`);',
      '}',
    ].join('\n');

    expect(scan('fixture.ts', source).found).toEqual([
      'fixture.ts:3 ${user.email}',
      'fixture.ts:4 ${upn ?? id}',
      'fixture.ts:5 ${identityIdOrEmail}',
      'fixture.ts:10 ${targetEmail || "all users"}',
      'fixture.ts:11 ${o.accountIdentifier}',
    ]);
  });

  const results = sourceFiles(SRC).map((file) =>
    scan(path.relative(SRC, file), fs.readFileSync(file, 'utf8')),
  );

  it('reads the logger templates of backend/src', () => {
    // Almost 700 when this was written (23 with a clear address): far fewer means the scan
    // lost them
    expect(results.reduce((sum, r) => sum + r.templates, 0)).toBeGreaterThanOrEqual(500);
  });

  it('finds no address in clear', () => {
    expect(results.flatMap((r) => r.found)).toEqual([]);
  });
});
