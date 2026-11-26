import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { EventsGateway } from './events.gateway';
import { RealTimeBridgeService } from './realtime-bridge.service';
import { RealTimeController } from './realtime.controller';

/** WebSocket gateway — bridges domain events to frontend clients */
@Module({
  imports: [EventsModule],
  providers: [EventsGateway, RealTimeBridgeService],
  controllers: [RealTimeController],
  exports: [EventsGateway],
})
export class RealTimeModule {}
