/**
 * Correlation rule types — configurable strategies for linking records across systems.
 * Extracted to shared to avoid circular imports between identity and correlation-config modules.
 */

export type CorrelationStrategy =
  | 'employeeNumber'
  | 'email'
  | 'hashedNationalId'
  | 'composite'
  | 'heuristicName';

export interface CorrelationRule {
  strategy: CorrelationStrategy;
  compositeFields?: string[];
  nationalIdSourceField?: string;
  nameMatchThreshold?: number;
  nameMatchMode?: 'exact' | 'fuzzy' | 'both';
  confidenceThreshold?: number;
}

export interface CorrelationConfig {
  rules: CorrelationRule[];
  conflictAction: 'auto-link' | 'review';
  confidenceThreshold?: number;
  fieldMasteryOverrides?: Record<string, string[]>;
  hrWriteback?: boolean;
}
