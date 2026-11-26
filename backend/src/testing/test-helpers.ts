/**
 * Shared test helpers for NestJS Testing Module setup.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ModuleMetadata } from '@nestjs/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { RedisSecurityStateStore } from '@infrastructure/cache/security-state.store';

/** Tenant ID for tests — use with withTestTenant when tests touch the DB. */
export const TEST_TENANT_ID = 'test-tenant';

/**
 * Run a test body within tenant context.
 * Required for tests that create/find Mongoose documents (tenant plugin scopes all queries).
 */
export function withTestTenant<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return withTenantContext(TEST_TENANT_ID, fn);
}

/**
 * Creates a NestJS testing module with common defaults.
 * Use for service-level unit tests with mocked dependencies.
 */
export async function createTestingModule(metadata: ModuleMetadata): Promise<TestingModule> {
  return Test.createTestingModule(metadata).compile();
}

/**
 * Creates a mock logger that captures log calls for assertion.
 */
export function createMockLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
}

/**
 * Creates a mock LoggerFactoryService that returns a mock logger.
 */
export function createMockLoggerFactory() {
  const logger = createMockLogger();
  return {
    factory: { create: jest.fn().mockReturnValue(logger) },
    logger,
  };
}

/**
 * Creates a mock DomainEventEmitterService.
 */
export function createMockEventEmitter() {
  return {
    emit: jest.fn(),
    emitAndWait: jest.fn().mockResolvedValue([]),
  };
}

/**
 * The security state store while Redis is down: a RedisSecurityStateStore whose client rejects
 * every command, so each store call rejects with SecurityStateUnavailableError.
 */
export function createUnavailableSecurityStateStore(): RedisSecurityStateStore {
  const down = () => jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  return new RedisSecurityStateStore({
    get: down(),
    set: down(),
    del: down(),
    eval: down(),
    quit: jest.fn().mockResolvedValue('OK'),
  });
}
