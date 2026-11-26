/**
 * What every section of the demo seed builds from: the tenant, the run's day and the people.
 */
import type { Types } from 'mongoose';
import { DEMO_SEED_KEY, SeededRandom, seededObjectId } from './random';
import type { DemoPerson } from './people';

/** The marker the seed's root documents carry (metadata.demoSeed, createdBy, workflowId). */
export const DEMO_SEED_MARKER = 'demo-seed';

export interface SeedContext {
  tenantId: string;
  /** Midnight UTC of the run's day: seeded dates count from it. */
  anchor: Date;
  people: DemoPerson[];
}

/** A random stream of its own per section, so one section's changes leave the others alone. */
export function sectionRandom(section: string): SeededRandom {
  return new SeededRandom(`${DEMO_SEED_KEY}|${section}`);
}

export function identityId(ctx: SeedContext, index: number): Types.ObjectId {
  return seededObjectId(ctx.tenantId, 'identity', index);
}

export function personId(ctx: SeedContext, person: DemoPerson): string {
  return String(identityId(ctx, person.index));
}

export function managerOf(ctx: SeedContext, person: DemoPerson): DemoPerson | undefined {
  return person.managerIndex === undefined ? undefined : ctx.people[person.managerIndex];
}

/** People still employed and provisioned (the ones most demo data is about). */
export function workingPeople(ctx: SeedContext): DemoPerson[] {
  return ctx.people.filter((p) =>
    ['active', 'mover-batch', 'mover-done', 'leaver-batch'].includes(p.lifecycle),
  );
}

/** "Anna Virtanen" */
export function fullName(person: DemoPerson): string {
  return `${person.firstName} ${person.lastName}`;
}
