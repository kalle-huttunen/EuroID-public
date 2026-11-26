/**
 * Migration 20261126000008 (final review AG6): active rules with a condition group without
 * conditions matched everyone before this release and match nobody after it. The migration only
 * reports them per tenant for the operator to review; it changes no document.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import {
  up,
  emptyConditionGroupPolicies,
} from '../../../migrations/20261126000008-report-empty-condition-groups';

describe('Migration: report active rules with an empty condition group (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  const condition = { id: 'c1', field: 'departmentName', operator: 'equals', value: 'Sales' };
  const ids = {
    empty: new ObjectId(),
    nullConditions: new ObjectId(),
    otherTenant: new ObjectId(),
    full: new ObjectId(),
    draft: new ObjectId(),
  };

  async function seed(label: string) {
    const db = client.db(testDbName(label));
    await db.collection('policies').insertMany([
      {
        _id: ids.empty,
        tenantId: 'a',
        name: 'Everyone gets Teams',
        status: 'active',
        conditionGroups: [
          { id: 'g1', join: 'AND', conditions: [condition] },
          { id: 'g2', join: 'AND', conditions: [] },
        ],
      },
      {
        _id: ids.nullConditions,
        tenantId: 'a',
        name: 'Legacy rule',
        status: 'active',
        conditionGroups: [{ id: 'g1', join: 'OR', conditions: null }],
      },
      {
        _id: ids.otherTenant,
        tenantId: 'b',
        name: 'All staff',
        status: 'active',
        conditionGroups: [{ id: 'g1', join: 'AND', conditions: [] }],
      },
      // Not reported: every group has conditions, or the rule is not active
      {
        _id: ids.full,
        tenantId: 'a',
        name: 'Sales',
        status: 'active',
        conditionGroups: [{ id: 'g1', join: 'AND', conditions: [condition] }],
      },
      {
        _id: ids.draft,
        tenantId: 'a',
        name: 'Draft',
        status: 'draft',
        conditionGroups: [{ id: 'g1', join: 'AND', conditions: [] }],
      },
    ]);
    return db;
  }

  it('names each active rule with an empty group, by tenant', async () => {
    const db = await seed('empty-condition-group-report');

    expect(await emptyConditionGroupPolicies(db)).toEqual({
      a: expect.arrayContaining([
        `${ids.empty.toHexString()} (Everyone gets Teams)`,
        `${ids.nullConditions.toHexString()} (Legacy rule)`,
      ]),
      b: [`${ids.otherTenant.toHexString()} (All staff)`],
    });
    expect((await emptyConditionGroupPolicies(db)).a).toHaveLength(2);
  });

  it('logs them and changes no rule, also when run twice', async () => {
    const db = await seed('empty-condition-group-report-up');
    const before = await db.collection('policies').find({}).sort({ _id: 1 }).toArray();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await up(db);
    await up(db);

    expect(await db.collection('policies').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain(ids.empty.toHexString());
    expect(logged).toContain(ids.otherTenant.toHexString());
    expect(logged).not.toContain(ids.full.toHexString());
    warn.mockRestore();
  });
});
