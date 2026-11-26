/** Types of the policy suggestion analysis (PolicySuggestionService). */
import type {
  SuggestedPolicy,
  SuggestionEvidence,
  SuggestionType,
} from './schemas/suggestion.schema';

export interface SuggestionCandidate {
  type: SuggestionType;
  confidence: number;
  title: string;
  description: string;
  suggestedPolicy?: SuggestedPolicy;
  evidence: SuggestionEvidence;
  sourcePolicyId?: string;
}

/** An analyzer that did not run, and why. */
export interface SkippedAnalyzer {
  analyzer: 'birthright' | 'orphan';
  reason: string;
}

/** The answer of POST /policy-suggestions/analyze. */
export interface AnalysisResult {
  /** Candidate suggestions the analyzers found (not identities read). */
  analyzed: number;
  suggestionsCreated: number;
  skipped: SkippedAnalyzer[];
}

export const ENTRA_NOT_CONFIGURED = 'Entra ID is not configured for this tenant';

export interface SuggestionFilter {
  type?: SuggestionType | SuggestionType[];
  status?: string | string[];
  confidenceMin?: number;
  page?: number;
  limit?: number;
}
