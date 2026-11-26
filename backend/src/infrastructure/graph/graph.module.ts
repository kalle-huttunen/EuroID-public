/**
 * Graph Module — Global Neo4j Infrastructure
 *
 * Provides GraphService globally so all modules can inject it
 * without explicit imports.
 */
import { Global, Module } from '@nestjs/common';
import { GraphService } from './graph.service';

@Global()
@Module({
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
