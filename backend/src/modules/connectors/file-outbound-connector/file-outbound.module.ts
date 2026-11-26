import { Module, forwardRef } from '@nestjs/common';
import { FileOutboundService } from './file-outbound.service';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [forwardRef(() => ConnectorConfigModule)],
  providers: [FileOutboundService],
  exports: [FileOutboundService],
})
export class FileOutboundConnectorModule {}
