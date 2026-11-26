/**
 * Deterministic randomness and ids for the demo seed: the same tenant and options give the same
 * people, ids and dates (relative to the run's day) in every run.
 */
import { createHash } from 'crypto';
import { Types } from 'mongoose';

/** Changing it changes every generated person and id. */
export const DEMO_SEED_KEY = 'euroid-demo-v1';

export const DAY_MS = 86_400_000;

/** Seconds of 2026-01-01T00:00:00Z: the timestamp part of the seeded ObjectIds starts here. */
const OBJECT_ID_EPOCH = 1_767_225_600;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** mulberry32: small, fast and good enough to spread demo data. */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Index into `weights`, chosen in proportion to them. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * The ObjectId of the `index`th document of `kind` in the tenant: stable across runs, different
 * per tenant (the _id index is global), ordered by index within a kind.
 */
export function seededObjectId(tenantId: string, kind: string, index: number): Types.ObjectId {
  const seconds = (OBJECT_ID_EPOCH + index).toString(16).padStart(8, '0');
  const rest = sha256(`${DEMO_SEED_KEY}|${tenantId}|${kind}|${index}`).slice(0, 16);
  return new Types.ObjectId(seconds + rest);
}

/** A version 4 shaped UUID, stable for the tenant and key (requestId, campaignId, ...). */
export function seededUuid(tenantId: string, key: string): string {
  const hex = sha256(`${DEMO_SEED_KEY}|${tenantId}|uuid|${key}`).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Midnight UTC of the day `date` falls on: all seeded dates count from it. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** `days` (may be negative or fractional) after `anchor`, plus `hours`. */
export function daysFrom(anchor: Date, days: number, hours = 0): Date {
  return new Date(anchor.getTime() + days * DAY_MS + hours * 3_600_000);
}

/** The calendar day of a UTC date, as HR exports write it (YYYY-MM-DD). */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
