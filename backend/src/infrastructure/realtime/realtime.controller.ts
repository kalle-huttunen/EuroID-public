import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { getRequestContext } from '../middleware/get-request-context';
import { EventsGateway } from './events.gateway';

@ApiTags('Real-Time')
@Controller('realtime')
@Roles('super-admin')
export class RealTimeController {
  constructor(private readonly gateway: EventsGateway) {}

  @Get('status')
  @ApiOperation({ summary: 'WebSocket connection status (super-admin only)' })
  @ApiResponse({ status: 200, description: 'Current connection stats' })
  @ApiResponse({ status: 403, description: 'Requires super-admin role' })
  getStatus(): { tenantId: string; connectedClients: number; rooms: Record<string, number> } {
    const tenantId = getRequestContext()?.tenantId ?? '';
    const ns = this.gateway.server.sockets;
    const allSockets = ns?.sockets ?? new Map();

    let tenantConnections = 0;
    allSockets.forEach((socket: { data?: { tenantId?: string } }) => {
      if (socket.data?.tenantId === tenantId) {
        tenantConnections++;
      }
    });

    const adapter = ns?.adapter;
    const roomsMap = adapter?.rooms as Map<string, Set<string>> | undefined;

    const rooms: Record<string, number> = {};
    const roomNames = ['anomalies', 'provisioning', 'drift', 'reviews', 'analytics', 'system'];
    for (const room of roomNames) {
      const prefixedRoom = tenantId ? `t:${tenantId}:${room}` : room;
      rooms[room] = roomsMap?.get(prefixedRoom)?.size ?? 0;
    }

    return { tenantId, connectedClients: tenantConnections, rooms };
  }
}
