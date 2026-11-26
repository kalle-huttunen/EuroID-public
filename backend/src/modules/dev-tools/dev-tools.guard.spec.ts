import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { DevToolsGuard } from './dev-tools.guard';

/**
 * The dev tools read decrypted workflow inputs and activity outputs, so they exist only where
 * NODE_ENV is development or test: staging, pre-prod and an unset NODE_ENV answer 404 like
 * production.
 */
describe('DevToolsGuard', () => {
  const saved = process.env.NODE_ENV;
  const context = {} as ExecutionContext;

  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  it.each(['development', 'test'])('allows the dev tools with NODE_ENV=%s', (env) => {
    process.env.NODE_ENV = env;
    expect(new DevToolsGuard().canActivate(context)).toBe(true);
  });

  it.each(['production', 'staging', 'pre-prod'])('answers 404 with NODE_ENV=%s', (env) => {
    process.env.NODE_ENV = env;
    expect(() => new DevToolsGuard().canActivate(context)).toThrow(NotFoundException);
  });

  it('answers 404 when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(() => new DevToolsGuard().canActivate(context)).toThrow(NotFoundException);
  });
});
