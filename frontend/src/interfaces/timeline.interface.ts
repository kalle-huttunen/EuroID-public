/**
 * Timeline event types for the Identity Hub user activity feed.
 * Matches backend event/history API when GET /identity/:id/events is implemented.
 */

export type TimelineEventType =
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_PROVISIONED'
  | 'USER_DEPROVISIONED'
  | 'POLICY_EVALUATED'
  | 'DRIFT_DETECTED'
  | 'DRIFT_RESOLVED'
  | 'GROUP_ASSIGNED'
  | 'GROUP_REMOVED'
  | 'LICENSE_ASSIGNED'
  | 'LICENSE_REMOVED'
  | 'WORKFLOW_STARTED'
  | 'WORKFLOW_COMPLETED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'STATUS_CHANGE'
  | 'LEAVER_DETECTED';

export type TimelineEventSeverity = 'info' | 'success' | 'warning' | 'error';

export interface ITimelineEvent {
  id: string;
  type: TimelineEventType;
  severity: TimelineEventSeverity;
  timestamp: string;
  title: string;
  description?: string;
  /** The system or user that triggered this event */
  actor: string;
  /** Target system involved (e.g., "Entra ID", "Active Directory") */
  targetSystem?: string;
  /** Additional metadata (field changes, group names, etc.) */
  metadata?: Record<string, unknown>;
}
