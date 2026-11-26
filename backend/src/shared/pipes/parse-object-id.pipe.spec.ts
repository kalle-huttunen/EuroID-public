import { BadRequestException } from '@nestjs/common';
import { ParseObjectIdPipe } from './parse-object-id.pipe';

/** An id route parameter is 24 hexadecimal characters; anything else is 400 before any read. */
describe('ParseObjectIdPipe', () => {
  const pipe = new ParseObjectIdPipe();

  it('passes a 24-character hexadecimal id', () => {
    expect(pipe.transform('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
    expect(pipe.transform('507F1F77BCF86CD799439011')).toBe('507F1F77BCF86CD799439011');
  });

  // Types.ObjectId.isValid accepts any 12-character string (12 bytes), which matches nothing.
  it.each(['aaaaaaaaaaaa', 'not-an-id', '', '507f1f77bcf86cd79943901', '507f1f77bcf86cd79943901g'])(
    'refuses %p with 400',
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});
