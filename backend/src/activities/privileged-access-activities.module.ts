import { Module } from '@nestjs/common';
import { PrivilegedAccessActivities } from './privileged-access.activities';
import { PrivilegedAccessModule } from '../modules/privileged-access/privileged-access.module';

@Module({
  imports: [PrivilegedAccessModule],
  providers: [PrivilegedAccessActivities],
  exports: [PrivilegedAccessActivities],
})
export class PrivilegedAccessActivitiesModule {}
