/**
 * Merkle Tree Unit Tests
 *
 * Tests for pure Merkle tree functions (F-07): tree construction,
 * proof generation, proof verification, and edge cases.
 */
import { createHash } from 'crypto';
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from './audit-merkle.service';

function hashPair(left: string, right: string): string {
  return createHash('sha256')
    .update(left + right)
    .digest('hex');
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('Merkle Tree — Pure Functions', () => {
  describe('buildMerkleTree', () => {
    it('should throw on empty input', () => {
      expect(() => buildMerkleTree([])).toThrow('Cannot build Merkle tree from empty leaf set');
    });

    it('should build tree from single leaf', () => {
      const leaf = sha256('event-1');
      const tree = buildMerkleTree([leaf]);

      expect(tree.leafCount).toBe(1);
      expect(tree.depth).toBe(1);
      // Single leaf — root is the leaf itself (only level)
      expect(tree.rootHash).toBe(leaf);
      expect(tree.levels).toHaveLength(1);
    });

    it('should build tree from 2 leaves (power of 2)', () => {
      const leaf0 = sha256('event-0');
      const leaf1 = sha256('event-1');
      const tree = buildMerkleTree([leaf0, leaf1]);

      expect(tree.leafCount).toBe(2);
      expect(tree.depth).toBe(2);
      expect(tree.rootHash).toBe(hashPair(leaf0, leaf1));
      expect(tree.levels).toHaveLength(2);
      expect(tree.levels[0]).toEqual([leaf0, leaf1]);
      expect(tree.levels[1]).toEqual([hashPair(leaf0, leaf1)]);
    });

    it('should build tree from 4 leaves (power of 2)', () => {
      const leaves = [0, 1, 2, 3].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      expect(tree.leafCount).toBe(4);
      expect(tree.depth).toBe(3);

      const h01 = hashPair(leaves[0], leaves[1]);
      const h23 = hashPair(leaves[2], leaves[3]);
      expect(tree.rootHash).toBe(hashPair(h01, h23));
    });

    it('should handle 3 leaves (odd — duplicates last)', () => {
      const leaves = [0, 1, 2].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      expect(tree.leafCount).toBe(3);
      // Level 0 should have 4 entries (3 + 1 duplicate)
      expect(tree.levels[0]).toHaveLength(4);
      expect(tree.levels[0][3]).toBe(leaves[2]); // duplicated last leaf

      const h01 = hashPair(leaves[0], leaves[1]);
      const h22 = hashPair(leaves[2], leaves[2]);
      expect(tree.rootHash).toBe(hashPair(h01, h22));
    });

    it('should handle 5 leaves (odd)', () => {
      const leaves = [0, 1, 2, 3, 4].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);
      expect(tree.leafCount).toBe(5);
      expect(tree.levels[0]).toHaveLength(6); // 5 + 1 duplicate
    });

    it('should handle large tree (1000 leaves): an odd inner level pairs its last node with itself', () => {
      const leaves = Array.from({ length: 1000 }, (_, i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      expect(tree.leafCount).toBe(1000);
      // 125 and 63 nodes are odd: their last node is hashed with itself, nothing is added
      expect(tree.levels.map((level) => level.length)).toEqual([
        1000, 500, 250, 125, 63, 32, 16, 8, 4, 2, 1,
      ]);
      expect(tree.depth).toBe(11);
      let level = leaves;
      while (level.length > 1) {
        level = Array.from({ length: Math.ceil(level.length / 2) }, (_, i) =>
          hashPair(level[2 * i], level[2 * i + 1] ?? level[2 * i]),
        );
      }
      expect(tree.rootHash).toBe(level[0]);
    });
  });

  describe('generateMerkleProof', () => {
    it('should throw for out-of-bounds index', () => {
      const tree = buildMerkleTree([sha256('a'), sha256('b')]);
      expect(() => generateMerkleProof(tree, -1)).toThrow();
      expect(() => generateMerkleProof(tree, 5)).toThrow();
    });

    it('should generate valid proof for 4-leaf tree', () => {
      const leaves = [0, 1, 2, 3].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      // Proof for leaf 0: needs leaf 1 (right sibling), then h23 (right sibling)
      const proof0 = generateMerkleProof(tree, 0);
      expect(proof0).toHaveLength(2);
      expect(proof0[0].hash).toBe(leaves[1]);
      expect(proof0[0].position).toBe('right');
    });

    it('should generate proof for leaf in middle of 8-leaf tree', () => {
      const leaves = Array.from({ length: 8 }, (_, i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      const proof3 = generateMerkleProof(tree, 3);
      // 8 leaves → 3 levels → proof should have 3 entries
      expect(proof3).toHaveLength(3);
    });
  });

  describe('verifyMerkleProof', () => {
    it('should verify valid proof for 4-leaf tree', () => {
      const leaves = [0, 1, 2, 3].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      for (let i = 0; i < 4; i++) {
        const proof = generateMerkleProof(tree, i);
        expect(verifyMerkleProof(leaves[i], proof, tree.rootHash)).toBe(true);
      }
    });

    it('should verify valid proof for 8-leaf tree', () => {
      const leaves = Array.from({ length: 8 }, (_, i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      for (let i = 0; i < 8; i++) {
        const proof = generateMerkleProof(tree, i);
        expect(verifyMerkleProof(leaves[i], proof, tree.rootHash)).toBe(true);
      }
    });

    it('should verify proof for odd-count tree (3 leaves)', () => {
      const leaves = [0, 1, 2].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      for (let i = 0; i < 3; i++) {
        const proof = generateMerkleProof(tree, i);
        expect(verifyMerkleProof(leaves[i], proof, tree.rootHash)).toBe(true);
      }
    });

    it('should reject proof when leaf hash is tampered', () => {
      const leaves = [0, 1, 2, 3].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      const proof = generateMerkleProof(tree, 2);
      const tamperedLeaf = sha256('tampered-event');
      expect(verifyMerkleProof(tamperedLeaf, proof, tree.rootHash)).toBe(false);
    });

    it('should reject proof when root hash is wrong', () => {
      const leaves = [0, 1, 2, 3].map((i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      const proof = generateMerkleProof(tree, 0);
      expect(verifyMerkleProof(leaves[0], proof, sha256('wrong-root'))).toBe(false);
    });

    it('should verify proofs for 1000-leaf tree', () => {
      const leaves = Array.from({ length: 1000 }, (_, i) => sha256(`event-${i}`));
      const tree = buildMerkleTree(leaves);

      // Spot-check several positions
      for (const idx of [0, 1, 499, 500, 998, 999]) {
        const proof = generateMerkleProof(tree, idx);
        expect(verifyMerkleProof(leaves[idx], proof, tree.rootHash)).toBe(true);
      }
    });
  });
});
