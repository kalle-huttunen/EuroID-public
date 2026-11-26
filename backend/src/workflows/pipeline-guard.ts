/**
 * The provisioning pipeline guard of the onboarding and mover workflows: only a DEPLOYED pipeline
 * provisions, as only a DEPLOYED one starts HR joiners (joiner-detection.service.ts). DRAFT and
 * SIMULATED come before the first Deploy (a STOPPED pipeline goes back through SIMULATED), PAUSED
 * is an operator's or the circuit breaker's pause.
 *
 * Workflow code: bundled into the workflows, so it must stay deterministic (pure functions).
 */

/** Why the pipeline lets nothing provision now, or undefined while it is DEPLOYED. */
export function pipelineBlockReason(status: string): string | undefined {
  if (status === 'DEPLOYED') return undefined;
  if (status === 'PAUSED' || status === 'STOPPED') {
    return `the provisioning pipeline is ${status.toLowerCase()}`;
  }
  return `the provisioning pipeline is not deployed (${status})`;
}

/**
 * The guard of the workflows before it required DEPLOYED: only a PAUSED or STOPPED pipeline
 * blocked. Kept for histories from before the patches that introduced pipelineBlockReason.
 */
export function legacyPipelineBlockReason(status: string): string | undefined {
  return status === 'PAUSED' || status === 'STOPPED' ? pipelineBlockReason(status) : undefined;
}

/** The onboarding result with the people the guard left unprovisioned counted, and why. */
export function withPipelineSkips(result: string, reasons: string[], total: number): string {
  if (reasons.length === 0) return result;
  return `${result} ${reasons.length} of ${total} not provisioned: ${[...new Set(reasons)].join('; ')}.`;
}
