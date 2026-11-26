/**
 * A mocked vendor HTTP API for connector tests: an axios-instance look-alike whose answers come
 * from one handler, recording every call. No request leaves the process.
 *
 * Usage: `jest.mock('axios')`, then `(axios.create as jest.Mock).mockReturnValue(api.instance)`.
 */

export interface FakeHttpCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

/** An axios-style error carrying the HTTP status, headers and body. */
export function httpError(
  status: number,
  headers: Record<string, string> = {},
  data: unknown = {},
): Error & {
  isAxiosError: true;
  response: { status: number; headers: Record<string, string>; data: unknown };
} {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true as const,
    response: { status, headers, data },
  });
}

/** The handler returns the response body (status 200) or throws httpError(...). */
export function fakeHttp(handler: (call: FakeHttpCall) => unknown) {
  const calls: FakeHttpCall[] = [];
  const answer = async (call: FakeHttpCall) => {
    calls.push(call);
    return { status: call.method === 'DELETE' ? 204 : 200, data: await handler(call) };
  };
  const instance = {
    get: (url: string, config?: { params?: Record<string, unknown> }) =>
      answer({ method: 'GET', url, params: config?.params }),
    post: (url: string, data?: unknown) => answer({ method: 'POST', url, data }),
    put: (url: string, data?: unknown) => answer({ method: 'PUT', url, data }),
    patch: (url: string, data?: unknown) => answer({ method: 'PATCH', url, data }),
    delete: (url: string, config?: { params?: Record<string, unknown> }) =>
      answer({ method: 'DELETE', url, params: config?.params }),
  };
  /** Calls that change something at the vendor (everything but GET). */
  const writes = () => calls.filter((c) => c.method !== 'GET');
  return { instance, calls, writes };
}
