import { Module, forwardRef } from '@nestjs/common';
import { ServiceNowService } from './servicenow.service';
import { ServiceNowClient } from './servicenow.client';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [forwardRef(() => ConnectorConfigModule)],
  providers: [ServiceNowClient, ServiceNowService],
  exports: [ServiceNowService],
})
export class ServiceNowConnectorModule {}
