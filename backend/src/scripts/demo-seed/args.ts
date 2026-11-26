/** The demo seed's command line (seed-demo-data.ts). */
import { DEFAULT_DEMO_COUNT } from './seed-demo';
import { MIN_COUNT } from './people';

export interface SeedArgs {
  tenantId: string;
  count: number;
  reset: boolean;
}

/** The command line, or an error that says what to fix. */
export function parseSeedArgs(argv: string[], env: NodeJS.ProcessEnv): SeedArgs {
  if (env.NODE_ENV === 'production') {
    throw new Error('The demo seed does not run with NODE_ENV=production.');
  }
  const args: SeedArgs = {
    tenantId: env.DEV_TENANT_ID || 'dev-tenant',
    count: DEFAULT_DEMO_COUNT,
    reset: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reset') args.reset = true;
    else if (arg === '--tenant' && argv[i + 1]) args.tenantId = argv[++i];
    else if (arg === '--count' && argv[i + 1]) args.count = Number(argv[++i]);
    else
      throw new Error(
        `Unknown or incomplete argument "${arg}". Use --tenant <id>, --count <n>, --reset.`,
      );
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(args.tenantId)) {
    throw new Error('--tenant takes a tenant id of letters, digits, "-" and "_".');
  }
  if (!Number.isInteger(args.count) || args.count < MIN_COUNT || args.count > 5000) {
    throw new Error(`--count takes a whole number from ${MIN_COUNT} to 5000.`);
  }
  return args;
}
