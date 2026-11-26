import { Module } from '@nestjs/common';
import { JsonApiHrClient } from './json-api-hr.client';
import { JsonApiHrService } from './json-api-hr.service';

@Module({
  providers: [JsonApiHrClient, JsonApiHrService],
  exports: [JsonApiHrService],
})
export class JsonApiHrConnectorModule {}
