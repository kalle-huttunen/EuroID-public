import { Injectable } from '@nestjs/common';
import {
  escapeRegex,
  parseSCIMFilter,
  parseSCIMFilterClause,
  SCIMError,
  type SCIMFilterClause,
} from '@shared/scim';
import { SCIM_ACTIVE_STATUSES } from './scim-inbound.mapper';

type MongoCondition = Record<string, unknown>;

/**
 * A string comparison. userName, emails.value and displayName are not case exact (RFC 7643
 * section 4.1.1), so eq, co and sw compare without case; the value is never a pattern.
 */
function stringCondition(op: SCIMFilterClause['op'], value = ''): MongoCondition {
  const escaped = escapeRegex(value);
  switch (op) {
    case 'eq':
    case 'ne':
      return { $regex: `^${escaped}$`, $options: 'i' };
    case 'co':
      return { $regex: escaped, $options: 'i' };
    case 'sw':
      return { $regex: `^${escaped}`, $options: 'i' };
    case 'gt':
      return { $gt: value };
    case 'ge':
      return { $gte: value };
    case 'lt':
      return { $lt: value };
    case 'le':
      return { $lte: value };
    case 'pr':
      return { $exists: true, $nin: [null, ''] };
  }
}

/**
 * The query for a filter on an attribute the SCIM response shows (ScimInboundMapper
 * .toSCIMResponse), from the query for one value of it; `ne` is everyone the `eq` query leaves.
 */
function userQuery(
  clause: SCIMFilterClause,
  matching: (condition: MongoCondition) => MongoCondition,
): MongoCondition {
  const positive = matching(stringCondition(clause.op, clause.value));
  return clause.op === 'ne' ? { $nor: [positive] } : positive;
}

/** SCIM User attribute → the identity query that matches it, as the response shows it. */
const USER_FILTERS: Record<string, (clause: SCIMFilterClause) => MongoCondition> = {
  // The response's userName is the UPN, else the email
  userName: (clause) =>
    userQuery(clause, (condition) => ({
      $or: [
        { 'profile.userPrincipalName': condition },
        { 'profile.userPrincipalName': null, 'profile.email': condition },
      ],
    })),
  'emails.value': (clause) => userQuery(clause, (condition) => ({ 'profile.email': condition })),
  displayName: (clause) => userQuery(clause, (condition) => ({ 'profile.displayName': condition })),
  // The response's active is true for ACTIVE and PENDING
  active: (clause) => {
    if (clause.op === 'pr') return {};
    const value = clause.value?.toLowerCase();
    if ((clause.op !== 'eq' && clause.op !== 'ne') || (value !== 'true' && value !== 'false')) {
      throw new SCIMError('invalidFilter', 'active takes eq or ne with true or false', '400');
    }
    const active = (value === 'true') === (clause.op === 'eq');
    return {
      'profile.status': active ? { $in: SCIM_ACTIVE_STATUSES } : { $nin: SCIM_ACTIVE_STATUSES },
    };
  },
};

/** SCIM Group attribute → entitlement catalog field */
const EUROID_GROUP_ATTRIBUTE_MAP: Record<string, string> = {
  displayName: 'name',
};

const SUPPORTED_SCIM_GROUP_ATTRS = new Set(Object.keys(EUROID_GROUP_ATTRIBUTE_MAP));

/**
 * Parses SCIM filter strings into MongoDB queries: Users on the identity collection, Groups on
 * the entitlement catalog.
 */
@Injectable()
export class ScimFilterService {
  /**
   * A single-clause SCIM User filter as an identity query. It matches the attribute as the SCIM
   * response shows it: userName is the UPN, else the email (`profile.userPrincipalName`,
   * `profile.email`); emails.value is `profile.email`; displayName is `profile.displayName` (an
   * identity without one shows its name and is not found by it); active is true for ACTIVE and
   * PENDING. eq, ne, co and sw compare text without case. Examples:
   *   userName eq "john@example.com"  → UPN, else email, equal to it in any case
   *   emails.value sw "john"          → profile.email starting with "john"
   *   active eq true                  → profile.status ACTIVE or PENDING
   *
   * An unsupported attribute or a filter that cannot be parsed throws SCIMError (400).
   */
  parseFilter(filterString: string): Record<string, unknown> {
    const trimmed = (filterString ?? '').trim();
    if (!trimmed) return {};

    let clause: SCIMFilterClause;
    try {
      clause = parseSCIMFilterClause(trimmed);
    } catch {
      throw new SCIMError('invalidFilter', 'Invalid SCIM user filter syntax', '400');
    }
    const query = USER_FILTERS[clause.attribute];
    if (!query) {
      throw new SCIMError(
        'invalidFilter',
        'Unsupported SCIM filter attribute. Supported: userName, displayName, emails.value, active',
        '400',
      );
    }
    return query(clause);
  }

  /**
   * The identities a new SCIM user would collide with: one whose userName (as the response
   * shows it) is `userName`, or whose email is `userName` or `email`, compared without case.
   */
  existingUserQuery(userName: string, email?: string): Record<string, unknown> {
    const sameEmail = (value: string) => ({ 'profile.email': stringCondition('eq', value) });
    return {
      $or: [
        USER_FILTERS.userName({ attribute: 'userName', op: 'eq', value: userName }),
        sameEmail(userName),
        ...(email && email !== userName ? [sameEmail(email)] : []),
      ],
    };
  }

  /**
   * Parse SCIM filter for Groups (displayName eq/co/sw).
   */
  parseGroupFilter(filterString: string): Record<string, unknown> {
    const trimmed = (filterString ?? '').trim();
    if (!trimmed) return {};

    const attrMatch = trimmed.match(/^(\S+)\s+/);
    if (!attrMatch) {
      throw new SCIMError('invalidFilter', 'Invalid filter syntax', '400');
    }
    const scimAttr = attrMatch[1];
    if (!SUPPORTED_SCIM_GROUP_ATTRS.has(scimAttr)) {
      throw new SCIMError(
        'invalidFilter',
        'Unsupported SCIM group filter attribute. Supported: displayName',
        '400',
      );
    }

    const mongoField = EUROID_GROUP_ATTRIBUTE_MAP[scimAttr];
    const transformed = trimmed.replace(new RegExp(`^${escapeRegex(scimAttr)}`), mongoField);

    try {
      return parseSCIMFilter(transformed) as Record<string, unknown>;
    } catch {
      throw new SCIMError('invalidFilter', 'Invalid SCIM group filter syntax', '400');
    }
  }
}
