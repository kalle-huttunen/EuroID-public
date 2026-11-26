import { Global, Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { LoggerFactoryService } from './contextual-logger.service';
import { getWinstonOptions } from './logger.config';

@Global()
@Module({
  imports: [
    WinstonModule.forRoot(getWinstonOptions()),
  ],
  providers: [LoggerFactoryService],
  exports: [LoggerFactoryService],
})
export class LoggerModule {}
