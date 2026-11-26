import { Schema, Document, Query, Aggregate, MongooseDefaultQueryMiddleware } from 'mongoose';
import { Logger } from '@nestjs/common';
import { requestContext } from '../middleware/correlation.middleware';

declare module 'mongoose' {
  interface QueryOptions {
    skipTenantScope?: boolean;
  }
  interface SchemaOptions {
    skipTenantPlugin?: boolean;
  }
  interface AggregateOptions {
    skipTenantScope?: boolean;
  }
}

const logger = new Logger('TenantPlugin');

/** Typed as MongooseDefaultQueryMiddleware[] so schema.pre(op, ...) resolves to the Query overload. */
const TENANT_SCOPED_OPERATIONS: MongooseDefaultQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
];

/** True for an embedded (single nested or array) subdocument. */
const isSubdocument = (doc: unknown): boolean =>
  !!(doc as { $isSubdocument?: boolean } | undefined)?.$isSubdocument;

/**
 * The schemas embedded in a schema the plugin was applied to. Mongoose applies a global plugin to
 * a model's schema first and then to each schema it embeds (helpers/schema/applyPlugins.js, the
 * same walk over `schema.paths`), so a schema is marked here before the plugin reaches it.
 */
const embeddedSchemas = new WeakSet<Schema>();

function markEmbeddedSchemas(schema: Schema): void {
  for (const type of Object.values(schema.paths) as { schema?: Schema }[]) {
    if (!type.schema || embeddedSchemas.has(type.schema)) continue;
    embeddedSchemas.add(type.schema);
    markEmbeddedSchemas(type.schema);
  }
}

/**
 * Mongoose plugin: auto-injects tenantId from AsyncLocalStorage into queries.
 *
 * SECURITY: Never fails open. When tenant context is missing, throws immediately.
 * Opt-out: Pass { skipTenantScope: true } in query options for intentional system-wide queries.
 * Schema opt-out: Schema.set('skipTenantPlugin', true) for schemas like Tenant.
 *
 * Registered globally, Mongoose also applies it to embedded schemas. A subdocument belongs to its
 * parent's tenant, so an embedded schema gets no tenantId path, index or hooks: the indexed path
 * made Mongoose build indexes such as sources.tenantId_1 that no query uses, and a stamped
 * subdocument came back from the API with a nested tenantId that strict update schemas refuse.
 * A schema must therefore not be both a model's schema and embedded in another model's: whichever
 * compiles first decides, and as an embedded schema it would get no tenant scope as a model.
 */
export function tenantPlugin(schema: Schema): void {
  if (embeddedSchemas.has(schema)) return;
  markEmbeddedSchemas(schema);
  if (schema.get('skipTenantPlugin')) return;

  if (!schema.path('tenantId')) {
    schema.add({
      tenantId: {
        type: String,
        required(this: unknown) {
          return !isSubdocument(this);
        },
        index: true,
      },
    });
  }

  for (const op of TENANT_SCOPED_OPERATIONS) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      if (this.getOptions?.()?.skipTenantScope) return;

      const filter = this.getFilter?.() ?? {};
      if (filter.tenantId !== undefined) {
        // Validate tenantId is a plain non-empty string (block MongoDB operator injection like { $gt: '' })
        if (typeof filter.tenantId !== 'string' || !filter.tenantId) {
          logger.error(
            `[SECURITY] ${op} query with invalid tenantId type (${typeof filter.tenantId}) on ${schema.get('collection') ?? 'unknown'} collection. ` +
              'TenantId must be a non-empty string.',
          );
          throw new Error('Invalid tenantId: must be a non-empty string.');
        }
        return; // Idempotency: do not override explicit valid tenantId
      }

      const ctx = requestContext.getStore();
      if (ctx?.tenantId) {
        this.where({ ...filter, tenantId: ctx.tenantId });
      } else {
        // Block unscoped queries to prevent cross-tenant data leaks
        logger.error(
          `[SECURITY] ${op} query attempted without tenant context on ${schema.get('collection') ?? 'unknown'} collection. ` +
            'Use { skipTenantScope: true } in options for intentional system-wide queries.',
        );
        throw new Error(
          `Tenant context required for ${op}. Set tenant context or use { skipTenantScope: true } for system queries.`,
        );
      }
    });
  }

  // Use pre('validate') so tenantId is set before validation runs (validate runs before save)
  schema.pre('validate', function (this: Document & { tenantId?: string }) {
    if (isSubdocument(this)) return;
    if (!this.tenantId) {
      const ctx = requestContext.getStore();
      if (ctx?.tenantId) {
        this.tenantId = ctx.tenantId;
      } else {
        logger.error(
          `[SECURITY] Document validate attempted without tenant context on ${schema.get('collection') ?? 'unknown'} collection.`,
        );
        throw new Error('Tenant context required for document creation.');
      }
    }
  });

  schema.pre('save', function (this: Document & { tenantId?: string }) {
    if (isSubdocument(this)) return;
    if (!this.tenantId) {
      const ctx = requestContext.getStore();
      if (ctx?.tenantId) {
        this.tenantId = ctx.tenantId;
      } else {
        logger.error(
          `[SECURITY] Document save attempted without tenant context on ${schema.get('collection') ?? 'unknown'} collection.`,
        );
        throw new Error('Tenant context required for document creation.');
      }
    }
  });

  schema.pre('aggregate', function (this: Aggregate<unknown[]>) {
    if (this.options?.skipTenantScope) return;

    const ctx = requestContext.getStore();
    if (ctx?.tenantId) {
      this.pipeline().unshift({ $match: { tenantId: ctx.tenantId } });
    } else {
      logger.error(
        `[SECURITY] aggregate query attempted without tenant context on ${schema.get('collection') ?? 'unknown'} collection. ` +
          'Use { skipTenantScope: true } in options for intentional system-wide queries.',
      );
      throw new Error(
        'Tenant context required for aggregate. Set tenant context or use { skipTenantScope: true } for system queries.',
      );
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose does not expose typed insertMany pre-hook
  (schema as any).pre('insertMany', function (next: unknown, docs: Record<string, unknown>[]) {
    const arr = Array.isArray(docs) ? docs : [docs];
    const ctx = requestContext.getStore();
    for (const doc of arr) {
      if (doc && typeof doc === 'object' && !doc.tenantId) {
        if (ctx?.tenantId) {
          doc.tenantId = ctx.tenantId;
        } else {
          logger.error(
            `[SECURITY] insertMany attempted without tenant context on ${schema.get('collection') ?? 'unknown'} collection.`,
          );
          throw new Error('Tenant context required for insertMany.');
        }
      }
    }
    // Mongoose 9 insertMany pre-hook does not receive next(); return normally to proceed.
    if (typeof next === 'function') {
      (next as () => void)();
    }
  });
}
