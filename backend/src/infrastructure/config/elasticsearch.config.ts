import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const elasticsearchSchema = z.object({
  ELASTICSEARCH_NODE: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_USERNAME: z.string().default(''),
  ELASTICSEARCH_PASSWORD: z.string().default(''),
  ELASTICSEARCH_INDEX_PREFIX: z.string().default('euroid'),
  ELASTICSEARCH_MAX_RETRIES: z
    .string()
    .transform((v) => parseInt(v || '3', 10))
    .default('3'),
  ELASTICSEARCH_REQUEST_TIMEOUT_MS: z
    .string()
    .transform((v) => parseInt(v || '30000', 10))
    .default('30000'),
  ELASTICSEARCH_BULK_FLUSH_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v || '5000', 10))
    .default('5000'),
  ELASTICSEARCH_BULK_FLUSH_SIZE: z
    .string()
    .transform((v) => parseInt(v || '500', 10))
    .default('500'),
});

export type ElasticsearchConfig = z.infer<typeof elasticsearchSchema>;

export const elasticsearchConfig = registerAs('elasticsearch', (): ElasticsearchConfig => {
  const parsed = elasticsearchSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Elasticsearch config validation failed: ${msg}`);
  }
  return parsed.data;
});
