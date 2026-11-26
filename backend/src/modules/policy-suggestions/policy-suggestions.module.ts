import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { policySuggestionsConfig } from '@infrastructure/config/policy-suggestions.config';
import { PolicySuggestionsController } from './policy-suggestions.controller';
import { PolicySuggestionService } from './policy-suggestions.service';
import { PolicySuggestion, PolicySuggestionSchema } from './schemas/suggestion.schema';
import { PolicyModule } from '../policy/policy.module';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PolicySuggestion.name, schema: PolicySuggestionSchema }]),
    ConfigModule.forFeature(policySuggestionsConfig),
    PolicyModule,
    IdentityModule,
    EntitlementCatalogModule,
    EntraConnectorModule,
  ],
  controllers: [PolicySuggestionsController],
  providers: [PolicySuggestionService],
  exports: [PolicySuggestionService],
})
export class PolicySuggestionsModule {}
