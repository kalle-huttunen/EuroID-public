import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from './schemas/entitlement-catalog.schema';
import { EntitlementCatalogService } from './entitlement-catalog.service';
import { EntitlementCatalogController } from './entitlement-catalog.controller';
import { ENTITLEMENT_CATALOG_PORT } from '@shared/interfaces/entitlement-catalog.port';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
    ]),
  ],
  controllers: [EntitlementCatalogController],
  providers: [
    EntitlementCatalogService,
    { provide: ENTITLEMENT_CATALOG_PORT, useExisting: EntitlementCatalogService },
  ],
  exports: [EntitlementCatalogService, ENTITLEMENT_CATALOG_PORT],
})
export class EntitlementCatalogModule {}
