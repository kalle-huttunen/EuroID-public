import { requestContext, RequestContext } from './correlation.middleware';

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
