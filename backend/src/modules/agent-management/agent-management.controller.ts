import { Controller, Post, Get, Delete, Body, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@infrastructure/auth/roles.decorator';
import { AgentManagementService } from './agent-management.service';
import { RegisterAgentDto, HeartbeatDto } from './agent.dto';

@ApiTags('Agent Management')
@ApiBearerAuth('jwt')
@Controller('agents')
export class AgentManagementController {
  constructor(private readonly agentService: AgentManagementService) {}

  @Post('register')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Register a new remote agent' })
  @ApiResponse({ status: 201, description: 'Agent registered successfully.' })
  @ApiResponse({ status: 400, description: 'Validation failed or max agents reached.' })
  @ApiResponse({ status: 409, description: 'Agent ID conflict.' })
  async register(@Body() dto: RegisterAgentDto) {
    return this.agentService.register(dto);
  }

  @Post(':agentId/heartbeat')
  @Roles('operator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Agent heartbeat ping' })
  @ApiResponse({ status: 200, description: 'Heartbeat recorded.' })
  @ApiResponse({ status: 404, description: 'Agent not found or decommissioned.' })
  async heartbeat(@Param('agentId') agentId: string, @Body() dto: HeartbeatDto) {
    return this.agentService.heartbeat(agentId, dto);
  }

  @Get()
  @Roles('super-admin')
  @ApiOperation({ summary: 'List agents for tenant' })
  @ApiResponse({ status: 200, description: 'List of agents.' })
  async findAll() {
    return this.agentService.findAll();
  }

  @Get('status')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Agent status summary (online/offline/degraded counts)' })
  @ApiResponse({ status: 200, description: 'Status summary.' })
  async getStatus() {
    return this.agentService.getStatusSummary();
  }

  @Get(':agentId')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Get agent details with health info' })
  @ApiResponse({ status: 200, description: 'Agent details.' })
  @ApiResponse({ status: 404, description: 'Agent not found.' })
  async findOne(@Param('agentId') agentId: string) {
    return this.agentService.findById(agentId);
  }

  @Delete(':agentId')
  @Roles('super-admin')
  @ApiOperation({ summary: 'Decommission (deregister) agent' })
  @ApiResponse({ status: 200, description: 'Agent decommissioned.' })
  @ApiResponse({ status: 404, description: 'Agent not found or already decommissioned.' })
  async decommission(@Param('agentId') agentId: string) {
    return this.agentService.decommission(agentId);
  }
}
