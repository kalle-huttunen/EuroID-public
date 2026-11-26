import { registerAs } from '@nestjs/config';

export interface PolicySuggestionsConfig {
  birthrightThreshold: number;
  coverageGapMinUsers: number;
  birthrightDimension: string;
}

export const policySuggestionsConfig = registerAs(
  'policySuggestions',
  (): PolicySuggestionsConfig => ({
    birthrightThreshold: parseInt(process.env.SUGGESTION_BIRTHRIGHT_THRESHOLD ?? '70', 10),
    coverageGapMinUsers: parseInt(process.env.SUGGESTION_COVERAGE_GAP_MIN ?? '5', 10),
    birthrightDimension: process.env.SUGGESTION_GROUP_BY ?? 'departmentName',
  }),
);
