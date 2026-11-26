import { Module, forwardRef } from '@nestjs/common';
import { GitHubService } from './github.service';
import { GitHubClient } from './github.client';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [forwardRef(() => ConnectorConfigModule)],
  providers: [GitHubClient, GitHubService],
  exports: [GitHubService],
})
export class GitHubConnectorModule {}
