/**
 * The clock for workflow code (CLAUDE.md safety rule 8: no `Date.now()` in workflows).
 *
 * Workflow files read the time only through workflowNow(); scripts/check-workflow-purity.sh
 * rejects `Date.now()` and an argument-less `new Date()` everywhere else in src/workflows/.
 * Inside a Temporal workflow the sandbox replaces Date with deterministic workflow time (the
 * start of the current workflow task, the same value on every replay), so this is replay-safe.
 * Outside a workflow (unit tests with mocked Temporal APIs) it is the ordinary clock.
 * `new Date(value)` that converts a given value is not a clock read and stays allowed.
 *
 * @see https://docs.temporal.io/develop/typescript/core-application#workflow-logic-requirements
 */
export function workflowNow(): Date {
  return new Date();
}
