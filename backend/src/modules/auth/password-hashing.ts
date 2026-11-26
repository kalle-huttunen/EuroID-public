/**
 * How console admin passwords are hashed and checked: argon2id for new hashes, legacy bcrypt
 * hashes still verified, and no reuse of the last PASSWORD_HISTORY_LIMIT passwords. Shared by
 * registration, sign-in, change-password and password reset, so every path applies the same rules.
 */
import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcryptjs';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export const PASSWORD_HISTORY_LIMIT = 5;

export function isLegacyBcryptHash(hash: string): boolean {
  return hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (isLegacyBcryptHash(hash)) {
    return bcrypt.compare(password, hash);
  }
  return argon2.verify(hash, password);
}

/** Refuses (400) a password that matches one of the stored recent hashes. */
export async function assertNotRecentlyUsed(password: string, history: string[]): Promise<void> {
  for (const oldHash of history) {
    if (await verifyPassword(password, oldHash)) {
      throw new BadRequestException(
        `Password was used recently. Choose a password you haven't used in your last ${PASSWORD_HISTORY_LIMIT} passwords.`,
      );
    }
  }
}

/** The history to store with a new hash: newest first, at most PASSWORD_HISTORY_LIMIT. */
export function historyWith(passwordHash: string, history: string[]): string[] {
  return [passwordHash, ...history].slice(0, PASSWORD_HISTORY_LIMIT);
}
