import { Module, forwardRef } from '@nestjs/common';
import { GoogleSheetsService } from './google-sheets.service';
import { GoogleSheetsClient } from './google-sheets.client';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [forwardRef(() => ConnectorConfigModule)],
  providers: [GoogleSheetsClient, GoogleSheetsService],
  exports: [GoogleSheetsService],
})
export class GoogleSheetsConnectorModule {}
