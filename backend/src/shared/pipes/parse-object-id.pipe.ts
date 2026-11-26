import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

/** 24 hexadecimal characters. Types.ObjectId.isValid also takes any 12-character string. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Validates that a route parameter is a valid MongoDB ObjectId.
 * Returns 400 Bad Request with a generic message instead of
 * leaking Mongoose CastError schema details.
 *
 * Usage: @Param('id', ParseObjectIdPipe) id: string
 */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string> {
  transform(value: string): string {
    if (!value || !OBJECT_ID.test(value)) {
      throw new BadRequestException(`Invalid ID format: ${value ?? 'undefined'}`);
    }
    return value;
  }
}
