/**
 * Elasticsearch Module — Global Infrastructure
 *
 * Provides ElasticsearchService globally so all modules can inject it
 * without explicit imports. Fail-open: gracefully degrades when ES is unavailable.
 */
import { Global, Module } from '@nestjs/common';
import { ElasticsearchService } from './elasticsearch.service';

@Global()
@Module({
  providers: [ElasticsearchService],
  exports: [ElasticsearchService],
})
export class ElasticsearchModule {}
