/**
 * Correlation config types — matches backend correlation-rule.interface.ts
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
    /** For 'heuristicName': minimum similarity threshold (0-1). Default 0.8. */
    nameMatchThreshold?: number;
    /** For 'heuristicName': match mode */
    nameMatchMode?: 'exact' | 'fuzzy' | 'both';
    confidenceThreshold?: number;
}

export interface CorrelationConfig {
    rules: CorrelationRule[];
    conflictAction: 'auto-link' | 'review';
    confidenceThreshold?: number;
    fieldMasteryOverrides?: Record<string, string[]>;
    hrWriteback?: boolean;
    targetWriteback?: boolean;
}
