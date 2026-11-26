import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('answers with the promise when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('started'), 1000, 'too slow')).resolves.toBe(
      'started',
    );
    await expect(
      withTimeout(Promise.reject(new Error('refused')), 1000, 'too slow'),
    ).rejects.toThrow('refused');
  });

  it('fails with the message when the promise does not settle in time', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, 'The start did not answer within 20 ms')).rejects.toThrow(
      'The start did not answer within 20 ms',
    );
  });
});
