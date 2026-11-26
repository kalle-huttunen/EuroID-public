/**
 * GitHubConnector — Config and types.
 *
 * Dev connector: Invites users to a GitHub organization by email.
 */

/** Configuration for GitHubConnector */
export interface GitHubConfig {
  /** GitHub Personal Access Token with admin:org scope */
  personalAccessToken: string;
  /** GitHub organization slug (e.g., my-company) */
  orgName: string;
}

/** GitHub API invitation request body */
export interface GitHubInvitationRequest {
  invitee_id: number | null;
  email: string;
  role: 'direct_member' | 'admin' | 'billing_manager';
}

/** One entry of GET /orgs/{org}/invitations or /failed_invitations (fields EuroID reads). */
export interface GitHubOrgInvitation {
  id: number;
  email: string | null;
  login: string | null;
  failed_at?: string | null;
}

/** A GitHub account as GET /users/{username} and GET /user/{account_id} return it (fields EuroID reads). */
export interface GitHubAccount {
  /** Durable user id: survives a change of login. */
  id: number;
  login: string;
}

/** The account offboarding removes from the organization; neither field: by email (invitation). */
export interface GitHubAccountRef {
  /** GitHub user id onboarding wrote back (`github-user-<id>`); its current login is looked up. */
  userId?: number;
  /** The identity's GitHub login (custom attribute `githubLogin`), used when no user id is stored. */
  login?: string;
}

/** What provisioning did. */
export interface GitHubProvisionResult {
  targetUserId: string;
  /** The invitation GitHub created; none when the person was already invited or a member. */
  invitationId?: number;
  /** The account invited by its id, when the identity has a GitHub login. */
  account?: GitHubAccount;
}
