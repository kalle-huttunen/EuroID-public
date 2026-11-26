/**
 * Binary Merkle trees over audit event hashes: build, prove, verify. Pure functions, no side
 * effects. AuditMerkleService builds checkpoints with them.
 */

import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

export interface MerkleTree {
  rootHash: string;
  levels: string[][];
  leafCount: number;
  depth: number;
}

export interface MerkleProof {
  valid: boolean;
  proof: Array<{ hash: string; position: 'left' | 'right' }>;
  rootHash: string;
  leafHash: string;
}

/**
 * Compute SHA-256 hash of two concatenated strings.
 */
function hashPair(left: string, right: string): string {
  return createHash('sha256')
    .update(left + right)
    .digest('hex');
}

/**
 * Build a binary Merkle tree from leaf hashes.
 * Pure function — no side effects.
 *
 * @throws BadRequestException when leafHashes is empty
 */
export function buildMerkleTree(leafHashes: string[]): MerkleTree {
  if (leafHashes.length === 0) {
    throw new BadRequestException('Cannot build Merkle tree from empty leaf set');
  }

  const levels: string[][] = [];
  let currentLevel = [...leafHashes];

  // If odd number of leaves, duplicate the last
  if (currentLevel.length > 1 && currentLevel.length % 2 !== 0) {
    currentLevel.push(currentLevel[currentLevel.length - 1]);
  }

  levels.push(currentLevel);

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] ?? currentLevel[i]; // single remaining node
      nextLevel.push(hashPair(left, right));
    }
    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  return {
    rootHash: currentLevel[0],
    levels,
    leafCount: leafHashes.length,
    depth: levels.length,
  };
}

/**
 * Generate a Merkle proof for a leaf at the given index.
 * Pure function — no side effects.
 */
export function generateMerkleProof(
  tree: MerkleTree,
  leafIndex: number,
): Array<{ hash: string; position: 'left' | 'right' }> {
  if (leafIndex < 0 || leafIndex >= tree.levels[0].length) {
    throw new BadRequestException(`Leaf index ${leafIndex} out of bounds`);
  }

  const proof: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let idx = leafIndex;

  for (let level = 0; level < tree.levels.length - 1; level++) {
    const currentLevel = tree.levels[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;

    if (siblingIdx < currentLevel.length) {
      proof.push({
        hash: currentLevel[siblingIdx],
        position: isRight ? 'left' : 'right',
      });
    } else {
      // Odd level: last node is duplicated (paired with itself)
      proof.push({
        hash: currentLevel[idx],
        position: 'right',
      });
    }

    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof.
 * Pure function — no side effects.
 */
export function verifyMerkleProof(
  leafHash: string,
  proof: Array<{ hash: string; position: 'left' | 'right' }>,
  expectedRoot: string,
): boolean {
  let currentHash = leafHash;

  for (const step of proof) {
    if (step.position === 'left') {
      currentHash = hashPair(step.hash, currentHash);
    } else {
      currentHash = hashPair(currentHash, step.hash);
    }
  }

  return currentHash === expectedRoot;
}
