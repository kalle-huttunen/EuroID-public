/**
 * HR joiner policy: the per-tenant limit on how many onboarding runs one HR sync may start without
 * an admin's approval (`joiner_policies`), and the defaults a tenant without a stored policy gets.
 * Defaults come from the environment; the fallbacks are the leaver and mover shape (plan 2.7):
 * min(10, 5 % of active identities), with a floor of 2 automatic joiners per sync.
 */

export interface JoinerPolicySettings {
  /** One sync may start at most this many onboarding runs... */
  massJoinerMaxCount: number;
  /** ...and at most this percentage of the tenant's active identities; the smaller limit wins... */
  massJoinerMaxPercent: number;
  /** ...but always at least this many, so a small tenant is not paused for every new hire. */
  massJoinerMinCount: number;
}

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envPercent(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

/** Defaults for a tenant without a stored joiner policy. Read at call time so tests can set env. */
export function defaultJoinerPolicy(): JoinerPolicySettings {
  const massJoinerMaxCount = envInt('JOINER_MASS_MAX_COUNT', 10);
  return {
    massJoinerMaxCount,
    massJoinerMaxPercent: envPercent('JOINER_MASS_MAX_PERCENT', 5),
    massJoinerMinCount: Math.min(envInt('JOINER_MASS_MIN_COUNT', 2), massJoinerMaxCount),
  };
}

/**
 * How many onboarding runs one sync may start without approval: the smaller of the count limit
 * and the percentage of active identities (rounded down), raised to the floor
 * `massJoinerMinCount`. A sync exceeds it with one more.
 *
 * With the defaults (10, 5 %, 2): 2 up to 59 active identities, 5 % from 60, 10 from 200 on. The
 * first import of a whole company is far above it, so it waits for a person.
 */
export function massJoinerAllowance(
  policy: JoinerPolicySettings,
  activeIdentities: number,
): number {
  const byPercent = Math.floor((activeIdentities * policy.massJoinerMaxPercent) / 100);
  return Math.max(policy.massJoinerMinCount, Math.min(policy.massJoinerMaxCount, byPercent));
}
