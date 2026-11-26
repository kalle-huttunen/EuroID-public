import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { maskPiiDeep } from './identity-pii';

/**
 * Masks the PII_FIELDS of every response body of the controller it decorates.
 * The clear values are available only through POST /identity/:id/pii/reveal (audited).
 */
@Injectable()
export class MaskPiiInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body: unknown) => maskPiiDeep(body)));
  }
}
