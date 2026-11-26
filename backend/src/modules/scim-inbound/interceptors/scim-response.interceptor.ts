import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { SCIM_CONTENT_TYPE } from '@shared/scim';

/**
 * Interceptor that sets Content-Type: application/scim+json on all SCIM responses.
 * Applied at the controller level on all SCIM controllers.
 */
@Injectable()
export class ScimResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Set Content-Type before response is sent
    const response = context.switchToHttp().getResponse();
    response.setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return next.handle();
  }
}
