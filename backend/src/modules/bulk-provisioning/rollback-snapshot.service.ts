/**
 * Encrypted, tenant-scoped store for the state a bulk rollback restores (see
 * schemas/rollback-snapshot.schema.ts). Callers keep only the returned reference.
 */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import {
  RollbackSnapshot,
  type RollbackSnapshotDocument,
  type RollbackSnapshotKind,
} from './schemas/rollback-snapshot.schema';

@Injectable()
export class RollbackSnapshotService {
  constructor(
    @InjectModel(RollbackSnapshot.name)
    private readonly snapshotModel: Model<RollbackSnapshotDocument>,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Store `state` encrypted and return its reference. With `key`, a later save under the same
   * key (a retried activity) returns the first snapshot's reference and leaves its state as is.
   */
  async save(
    tenantId: string,
    kind: RollbackSnapshotKind,
    state: unknown,
    key?: string,
  ): Promise<string> {
    const ciphertext = this.encryption.encrypt(JSON.stringify(state));
    if (!key) {
      const created = await this.snapshotModel.create({ tenantId, kind, ciphertext });
      return String(created._id);
    }
    const snapshot = await this.snapshotModel
      .findOneAndUpdate(
        { tenantId, key },
        { $setOnInsert: { tenantId, key, kind, ciphertext } },
        { upsert: true, new: true },
      )
      .exec();
    return String(snapshot._id);
  }

  /** The state stored under `ref` for this tenant and kind, or null when there is none (expired). */
  async load<T>(tenantId: string, kind: RollbackSnapshotKind, ref: string): Promise<T | null> {
    if (!isValidObjectId(ref)) return null;
    const snapshot = await this.snapshotModel.findOne({ _id: ref, tenantId, kind }).lean().exec();
    if (!snapshot) return null;
    return JSON.parse(this.encryption.decrypt(snapshot.ciphertext)) as T;
  }
}
