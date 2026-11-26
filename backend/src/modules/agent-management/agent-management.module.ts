import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Agent, AgentSchema } from './agent.schema';
import { AgentManagementService } from './agent-management.service';
import { AgentManagementController } from './agent-management.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Agent.name, schema: AgentSchema }])],
  controllers: [AgentManagementController],
  providers: [AgentManagementService],
  exports: [AgentManagementService],
})
export class AgentManagementModule {}
