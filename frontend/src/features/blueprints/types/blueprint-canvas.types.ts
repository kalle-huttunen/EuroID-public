/**
 * Blueprint canvas shared types.
 * Re-exports PipelineConfig from DeployModal; defines serialized label structure.
 */
import type { PipelineConfig } from '../DeployModal';

export type { PipelineConfig };

/** Serialized label data from persisted canvas (text + icon or React element props) */
export interface SerializedLabelData {
  text?: string;
  icon?: string;
  props?: { children?: unknown };
}

/** A policy node to add to the canvas (NodePalette): its type and initial data. */
export interface PolicyNodeTemplate {
  type: 'condition' | 'action';
  data: Record<string, unknown>;
}
