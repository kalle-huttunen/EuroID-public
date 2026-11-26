import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DataRetentionService } from './data-retention.service';
import { DataRetentionController } from './data-retention.controller';
import { Identity, IdentitySchema } from '../../modules/identity/schemas/identity.schema';
import { dataRetentionConfig } from '../config/data-retention.config';

@Module({
  imports: [
    ConfigModule.forFeature(dataRetentionConfig),
    MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
  ],
  controllers: [DataRetentionController],
  providers: [DataRetentionService],
  exports: [DataRetentionService],
})
export class RetentionModule {}
