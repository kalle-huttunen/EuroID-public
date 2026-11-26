import { Module } from '@nestjs/common';
import { CsvHrService } from './csv-hr.service';

@Module({
  providers: [CsvHrService],
  exports: [CsvHrService],
})
export class CsvHrConnectorModule {}
