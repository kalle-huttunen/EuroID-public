/**
 * A resource addressed by its own public id (a UUID such as `anomalyId`), and where a released
 * UI still sends it, by its document `_id` (an ObjectId). Anything else is 400 before a lookup.
 */
import { BadRequestException } from '@nestjs/common';
import { ParsePublicIdPipe, publicIdFilter, publicIdKind } from './parse-public-id.pipe';

const UUID = '0b5e2c1d-7a43-4f0e-9d7a-2a1c3b4d5e6f';
const OBJECT_ID = '665f1c2a1b2c3d4e5f607181';

describe('publicIdKind', () => {
  it.each([
    [UUID, 'uuid'],
    [UUID.toUpperCase(), 'uuid'],
    [OBJECT_ID, 'objectId'],
    [OBJECT_ID.toUpperCase(), 'objectId'],
  ])('%s is a %s', (value, kind) => {
    expect(publicIdKind(value)).toBe(kind);
  });

  it.each([
    'garbage',
    // 12 characters: Types.ObjectId.isValid accepts it, but no route id looks like that.
    'abcdefghijkl',
    `${OBJECT_ID}0`,
    `${UUID} `,
    '',
    '{"$ne":null}',
  ])('%j is neither', (value) => {
    expect(publicIdKind(value)).toBeNull();
  });
});

describe('publicIdFilter', () => {
  it('looks a UUID up by the public id field', () => {
    expect(publicIdFilter('anomalyId', UUID)).toEqual({ anomalyId: UUID });
  });

  it('looks an ObjectId up by _id', () => {
    expect(publicIdFilter('anomalyId', OBJECT_ID)).toEqual({ _id: OBJECT_ID });
  });

  it('looks anything else up by the public id field, where it matches nothing', () => {
    expect(publicIdFilter('anomalyId', 'garbage')).toEqual({ anomalyId: 'garbage' });
  });
});

describe('ParsePublicIdPipe', () => {
  it('passes a UUID through', () => {
    expect(new ParsePublicIdPipe().transform(UUID)).toBe(UUID);
  });

  it('refuses an ObjectId unless the resource accepts one', () => {
    expect(() => new ParsePublicIdPipe().transform(OBJECT_ID)).toThrow(BadRequestException);
    expect(new ParsePublicIdPipe({ acceptObjectId: true }).transform(OBJECT_ID)).toBe(OBJECT_ID);
  });

  it.each(['garbage', 'abcdefghijkl', ''])('answers 400 "Invalid ID format" for %j', (value) => {
    const pipe = new ParsePublicIdPipe({ acceptObjectId: true });
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
    expect(() => pipe.transform(value)).toThrow(/^Invalid ID format/);
  });
});
