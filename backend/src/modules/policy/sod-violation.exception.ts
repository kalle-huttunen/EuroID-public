import { HttpException, HttpStatus } from '@nestjs/common';
import type { SodViolation } from './sod.service';

/** Thrown when provisioning intent violates a BLOCK SoD policy. */
export class SoDViolationException extends HttpException {
  constructor(public readonly violations: SodViolation[]) {
    super(
      {
        statusCode: 409,
        error: 'SoD Violation',
        message: `Segregation of Duties conflict: ${violations.map((v) => v.policyName).join(', ')}`,
        violations,
      },
      HttpStatus.CONFLICT,
    );
  }
}
