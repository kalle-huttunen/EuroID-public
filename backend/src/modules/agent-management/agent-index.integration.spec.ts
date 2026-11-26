import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { Agent, AgentSchema } from './agent.schema';
import { up, down } from '../../../migrations/20261122000000-agent-id-per-tenant-unique';

const GLOBAL_INDEX = 'agentId_1';
const TENANT_INDEX = 'tenantId_1_agentId_1';

function agent(tenantId: string, agentId: string) {
  return { tenantId, agentId, name: `Agent ${agentId}`, taskQueue: `agent-${tenantId}` };
}

/**
 * An agentId is unique inside its tenant only. A global unique index made a second tenant's
 * registration fail on an id the first tenant uses, which also told it that the id exists.
 * Runs on the mongodb-memory-server binary; set MONGOMS_SYSTEM_BINARY to run it on another
 * server version (verified on 7.0).
 */
describe('agents agentId uniqueness', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('schema', () => {
    let connection: mongoose.Connection;
    let AgentModel: mongoose.Model<unknown>;

    beforeAll(async () => {
      connection = await mongoose
        .createConnection(testDbUri('schema'), { autoIndex: false })
        .asPromise();
      AgentModel = connection.model(Agent.name, AgentSchema) as mongoose.Model<unknown>;
      await AgentModel.createIndexes();
    });

    afterAll(async () => {
      await connection?.close();
    });

    it('builds the per-tenant unique index and no global one', async () => {
      const indexes = await AgentModel.collection.indexes();

      expect(indexes.find((i) => i.name === TENANT_INDEX)).toMatchObject({
        key: { tenantId: 1, agentId: 1 },
        unique: true,
      });
      expect(indexes.find((i) => i.name === GLOBAL_INDEX)).toBeUndefined();
    });

    it('lets two tenants register the same agentId', async () => {
      await AgentModel.create(agent('tenant-a', 'agent-shared'));

      await expect(AgentModel.create(agent('tenant-b', 'agent-shared'))).resolves.toBeDefined();
    });

    it('rejects a duplicate agentId inside one tenant', async () => {
      await AgentModel.create(agent('tenant-c', 'agent-dup'));

      await expect(AgentModel.create(agent('tenant-c', 'agent-dup'))).rejects.toMatchObject({
        code: 11000,
      });
    });
  });

  describe('migration', () => {
    let client: MongoClient;

    beforeAll(async () => {
      client = await MongoClient.connect(testDbUri());
    });

    afterAll(async () => {
      await client?.close();
    });

    /** The indexes the previous schema built: agentId unique on its own, plus the tenant pair. */
    async function legacyCollection(dbName: string) {
      const agents = client.db(testDbName(dbName)).collection('agents');
      await agents.createIndex({ agentId: 1 }, { name: GLOBAL_INDEX, unique: true });
      await agents.createIndex({ tenantId: 1, agentId: 1 }, { name: TENANT_INDEX, unique: true });
      return agents;
    }

    it('drops the global index, keeps the per-tenant one, and is safe to rerun', async () => {
      const agents = await legacyCollection('migration-legacy');
      await agents.insertOne(agent('tenant-a', 'agent-shared'));
      await expect(agents.insertOne(agent('tenant-b', 'agent-shared'))).rejects.toMatchObject({
        code: 11000,
      });

      await up(client.db(testDbName('migration-legacy')));
      await up(client.db(testDbName('migration-legacy')));

      const names = (await agents.indexes()).map((i) => i.name);
      expect(names).not.toContain(GLOBAL_INDEX);
      expect(names).toContain(TENANT_INDEX);
      await expect(agents.insertOne(agent('tenant-b', 'agent-shared'))).resolves.toBeDefined();
      await expect(agents.insertOne(agent('tenant-a', 'agent-shared'))).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('creates the per-tenant index when the collection lacks it', async () => {
      const agents = client.db(testDbName('migration-no-tenant-index')).collection('agents');
      await agents.createIndex({ agentId: 1 }, { name: GLOBAL_INDEX, unique: true });

      await up(client.db(testDbName('migration-no-tenant-index')));

      const index = (await agents.indexes()).find((i) => i.name === TENANT_INDEX);
      expect(index).toMatchObject({ key: { tenantId: 1, agentId: 1 }, unique: true });
      expect((await agents.indexes()).map((i) => i.name)).not.toContain(GLOBAL_INDEX);
    });

    it('does nothing harmful on a deployment without an agents collection', async () => {
      await expect(up(client.db(testDbName('migration-empty')))).resolves.toBeUndefined();
    });

    it('down restores the global index while no agentId is shared across tenants', async () => {
      const agents = await legacyCollection('migration-down');
      await up(client.db(testDbName('migration-down')));

      await down(client.db(testDbName('migration-down')));

      expect((await agents.indexes()).find((i) => i.name === GLOBAL_INDEX)).toMatchObject({
        unique: true,
      });
    });
  });
});
