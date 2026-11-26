import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import type { Readable } from 'stream';
import { CONNECTOR_TIMEOUT_HR_MS } from '@infrastructure/config/defaults';
import { safeLog } from '@infrastructure/observability/pii-redact.format';
import {
  createSsrfSafeHttpsAgent,
  isLocalFileAllowed,
  validateUrlForFetch,
} from '@infrastructure/url-validation/ssrf-guard';
import * as fs from 'fs';
import * as path from 'path';
import type { JsonApiHrAuth } from './json-api-hr.interface';

/** RFC 7230 token: the characters Node accepts in a header name. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Answers to a HEAD from a server that does not implement it for the feed. */
const HEAD_NOT_SUPPORTED = new Set([405, 501]);

/**
 * A feed request that failed (fetch): `status` when the server answered, `code` when no answer
 * came (ECONNREFUSED, ENOTFOUND, ECONNABORTED on the timeout), `notJson` for a local file that is
 * not JSON. The message is the one ingest shows (it can quote the start of the body); the health
 * check builds its own from these fields.
 */
export class JsonApiHrFetchError extends BadRequestException {
  constructor(
    message: string,
    readonly detail: { status?: number; code?: string; notJson?: boolean },
  ) {
    super(message);
  }
}

/**
 * The method the feed is read with: GET, whatever case, also for an empty or missing `method`.
 * Any other is refused (400) before a request is made: ingest is a read, and another method would
 * write to the HR system with the stored credentials. The connector settings offer no method;
 * this also gates a config saved through the API (checkedConnectorConfig).
 */
export function feedReadMethod(method: unknown): 'GET' {
  if (method == null || method === '' || String(method).toUpperCase() === 'GET') return 'GET';
  throw new BadRequestException(
    `JsonApiHrConnector: EuroID reads the feed with GET only: method "${String(method)}" is refused`,
  );
}

@Injectable()
export class JsonApiHrClient {
  private readonly logger = new Logger(JsonApiHrClient.name);
  /**
   * validateUrlForFetch checks the URL, then axios resolves the host again: the agent checks the
   * addresses it connects to, so a DNS answer that changed in between (rebinding) is refused.
   */
  private readonly httpsAgent = createSsrfSafeHttpsAgent();

  async fetch(config: { url: string; method?: string; auth?: JsonApiHrAuth }): Promise<unknown> {
    // Support local file paths only in dev/demo (SSRF: reject in production unless explicitly allowed)
    if (this.isLocalPath(config.url)) {
      if (!isLocalFileAllowed()) {
        throw new BadRequestException(
          'JsonApiHrConnector: Local file paths are disabled in production. Set ALLOW_JSON_API_LOCAL_FILES=true to override.',
        );
      }
      return this.readLocalFile(config.url);
    }

    const method = feedReadMethod(config.method);
    await validateUrlForFetch(config.url);

    const axiosConfig: AxiosRequestConfig = {
      url: config.url,
      method,
      timeout: CONNECTOR_TIMEOUT_HR_MS,
      // validateUrlForFetch checked only this URL: a redirect could lead to a private or
      // metadata address (SSRF) and would carry any credentials along.
      maxRedirects: 0,
      httpsAgent: this.httpsAgent,
      // No proxy from the environment: the agent must make the connection it checked.
      proxy: false,
    };
    if (config.auth) {
      axiosConfig.headers = this.buildAuthHeaders(config.auth);
    }

    try {
      const response = await axios(axiosConfig);
      return response.data;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const obj =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { status?: number; data?: unknown } }).response
          : undefined;
      const status = obj?.status;
      const data = obj?.data;
      const code =
        err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
          ? err.code
          : undefined;
      const bodySnippet =
        data !== undefined
          ? typeof data === 'string'
            ? data.slice(0, 50)
            : safeLog(data).slice(0, 50)
          : message.slice(0, 50);
      throw new JsonApiHrFetchError(
        `JsonApiHrConnector: HTTP ${status ?? 'error'} — ${bodySnippet}`,
        { status, code },
      );
    }
  }

  /**
   * Whether the HR endpoint answers 2xx to these credentials, without downloading the feed (the
   * health check). A HEAD request; when the server does not support HEAD (405, 501), the feed's
   * own request with its body never read: the connection is closed once the headers arrive. Both
   * share one `timeoutMs` deadline and follow no redirect, like fetch. A 401 or 403 is not
   * healthy. A local file (dev/demo): whether it exists, without reading it.
   */
  async probe(
    config: { url: string; method?: string; auth?: JsonApiHrAuth },
    timeoutMs: number,
  ): Promise<boolean> {
    const method = feedReadMethod(config.method);
    if (this.isLocalPath(config.url)) {
      return isLocalFileAllowed() && fs.existsSync(this.sandboxFilePath(config.url));
    }

    await validateUrlForFetch(config.url);
    const request: AxiosRequestConfig = {
      url: config.url,
      timeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxRedirects: 0,
      httpsAgent: this.httpsAgent,
      proxy: false,
      validateStatus: () => true,
      ...(config.auth ? { headers: this.buildAuthHeaders(config.auth) } : {}),
    };

    const head = await axios({ ...request, method: 'HEAD' });
    if (!HEAD_NOT_SUPPORTED.has(head.status)) return isSuccess(head.status);

    const response = await axios({
      ...request,
      method,
      responseType: 'stream',
    });
    (response.data as Readable).destroy();
    return isSuccess(response.status);
  }

  private buildAuthHeaders(auth: JsonApiHrAuth): Record<string, string> {
    if (auth.type === 'bearer') {
      this.assertSafeHeaderValue(auth.token);
      return { Authorization: `Bearer ${auth.token}` };
    }
    if (!HEADER_NAME_PATTERN.test(auth.name)) {
      throw new BadRequestException(
        'JsonApiHrConnector: authHeaderName is not a valid header name',
      );
    }
    this.assertSafeHeaderValue(auth.value);
    return { [auth.name]: auth.value };
  }

  /** Rejects control characters such as CR/LF (header injection). Never echoes the secret. */
  private assertSafeHeaderValue(value: string): void {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        throw new BadRequestException('JsonApiHrConnector: credential contains invalid characters');
      }
    }
  }

  private isLocalPath(url: string): boolean {
    if (url.startsWith('http://') || url.startsWith('https://')) return false;
    return (
      url.endsWith('.json') ||
      url.startsWith('/') ||
      url.startsWith('./') ||
      /^[A-Za-z]:[\\/]/.test(url)
    );
  }

  /**
   * Sandbox file path to prevent path traversal (F1).
   * Uses JSON_HR_ALLOWED_DIR or CSV_HR_ALLOWED_DIR; requires one in production.
   */
  private sandboxFilePath(filePath: string): string {
    const envDir = process.env.JSON_HR_ALLOWED_DIR ?? process.env.CSV_HR_ALLOWED_DIR;
    if (process.env.NODE_ENV === 'production' && !envDir) {
      throw new BadRequestException(
        'JsonApiHrConnector: JSON_HR_ALLOWED_DIR or CSV_HR_ALLOWED_DIR is required for local files in production.',
      );
    }
    const allowedDir = path.resolve(envDir || process.cwd());
    const resolved = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(allowedDir, filePath);
    if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
      throw new BadRequestException(
        `JsonApiHrConnector: Path traversal denied. Resolved path is outside allowed directory (F1)`,
      );
    }
    return resolved;
  }

  private readLocalFile(filePath: string): unknown {
    const resolved = this.sandboxFilePath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new BadRequestException(`JsonApiHrConnector: File not found`);
    }
    const content = fs.readFileSync(resolved, 'utf-8');
    try {
      return JSON.parse(content);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new JsonApiHrFetchError(`JsonApiHrConnector: Invalid JSON: ${msg}`, { notJson: true });
    }
  }
}

const isSuccess = (status: number) => status >= 200 && status < 300;
