import { WinstonModule } from 'nest-winston';
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';
import { piiRedactFormat } from './pii-redact.format';

const isProduction = process.env.NODE_ENV === 'production';
const piiRedactDisabled = process.env.LOG_PII_REDACT === 'false';

/**
 * Winston options used by both NestFactory bootstrap and WinstonModule.forRoot.
 * PII redaction applied in all environments unless LOG_PII_REDACT=false (local dev).
 */
export function getWinstonOptions(): Record<string, unknown> {
  const usePiiRedact = !piiRedactDisabled;
  const baseFormats = usePiiRedact
    ? [piiRedactFormat()]
    : [];

  return {
    level: isProduction ? 'info' : 'debug',
    transports: [
      new winston.transports.Console({
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp(),
              ...baseFormats,
              winston.format.json(),
            )
          : winston.format.combine(
              ...baseFormats,
              nestWinstonModuleUtilities.format.nestLike('EuroID', {
                prettyPrint: true,
              }),
            ),
      }),
    ],
  };
}

export function createLoggerConfig() {
  return WinstonModule.createLogger(getWinstonOptions());
}
