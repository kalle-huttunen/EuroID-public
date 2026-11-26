/**
 * User payload type for workflow/activity boundary.
 * Pure — no NestJS deps. Minimal shape for property access in activities.
 * Activities cast to StandardUserDto when calling services.
 */
export interface UserPayload {
  email?: string;
  firstName?: string;
  lastName?: string;
  sourceUserId?: string;
  userPrincipalName?: string;
  priority?: string;
}
