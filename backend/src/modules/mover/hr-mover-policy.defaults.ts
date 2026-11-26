/**
 * HR mover policy: the per-tenant limit on how many mover runs one HR sync may start without an
 * admin's approval (`mover_policies`), and the defaults a tenant without a stored policy gets.
 * Defaults come from the environment; the fallbacks are the owner's decision for 2.0cl: the 2.1
 * leaver shape, min(10, 5 % of active identities), with a floor of 2 automatic movers per sync.
 */

export interface MoverPolicySettings {
  /** One sync may start at most this many mover runs... */
  massMoverMaxCount: number;
  /** ...and at most this percentage of the tenant's active identities; the smaller limit wins... */
  massMoverMaxPercent: number;
  /** ...but always at least this many, so a small tenant is not paused for every move. */
  massMoverMinCount: number;
}

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envPercent(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

/** Defaults for a tenant without a stored mover policy. Read at call time so tests can set env. */
export function defaultMoverPolicy(): MoverPolicySettings {
  const massMoverMaxCount = envInt('MOVER_MASS_MAX_COUNT', 10);
  return {
    massMoverMaxCount,
    massMoverMaxPercent: envPercent('MOVER_MASS_MAX_PERCENT', 5),
    massMoverMinCount: Math.min(envInt('MOVER_MASS_MIN_COUNT', 2), massMoverMaxCount),
  };
}

/**
 * How many mover runs one sync may start without approval: the smaller of the count limit and
 * the percentage of active identities (rounded down), raised to the floor `massMoverMinCount`.
 * A sync exceeds it with one more.
 *
 * With the defaults (10, 5 %, 2): 2 up to 59 active identities, 5 % from 60, 10 from 200 on.
 */
export function massMoverAllowance(policy: MoverPolicySettings, activeIdentities: number): number {
  const byPercent = Math.floor((activeIdentities * policy.massMoverMaxPercent) / 100);
  return Math.max(policy.massMoverMinCount, Math.min(policy.massMoverMaxCount, byPercent));
}
