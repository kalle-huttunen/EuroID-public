import { BadRequestException, Injectable, Optional, PipeTransform } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 24 hex characters only: `Types.ObjectId.isValid` also accepts any 12-character string. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export type PublicIdKind = 'uuid' | 'objectId';

/** Which kind of id a route parameter is: a resource's public UUID, a document ObjectId, or neither. */
export function publicIdKind(value: string): PublicIdKind | null {
  if (UUID.test(value)) return 'uuid';
  if (OBJECT_ID.test(value)) return 'objectId';
  return null;
}

/**
 * Mongo filter for a resource addressed by its public id field (`anomalyId`, ...) or by its
 * document `_id`. Anything that is not an ObjectId is looked up by the public field, where a
 * value of neither kind matches nothing. Tenant scoping stays with the tenant plugin.
 */
export function publicIdFilter(publicIdField: string, id: string): Record<string, string> {
  return publicIdKind(id) === 'objectId' ? { _id: id } : { [publicIdField]: id };
}

/**
 * Validates `:id` of a resource addressed by its own public id, a UUID (`anomalyId`,
 * `suggestionId`): the id pages, events and API clients hold. With `acceptObjectId` the
 * document `_id` is accepted too, for a resource whose released UI still sends it. Anything else
 * is 400 "Invalid ID format", as `ParseObjectIdPipe` answers; look it up with `publicIdFilter`.
 *
 * Usage: @Param('id', new ParsePublicIdPipe({ acceptObjectId: true })) id: string
 */
@Injectable()
export class ParsePublicIdPipe implements PipeTransform<string, string> {
  constructor(@Optional() private readonly options: { acceptObjectId?: boolean } = {}) {}

  transform(value: string): string {
    const kind = value ? publicIdKind(value) : null;
    if (kind === 'uuid' || (kind === 'objectId' && this.options.acceptObjectId)) return value;
    throw new BadRequestException(`Invalid ID format: ${value ?? 'undefined'}`);
  }
}
