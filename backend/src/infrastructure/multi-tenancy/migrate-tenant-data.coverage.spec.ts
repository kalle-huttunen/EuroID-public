/**
 * POST /tenants/migrate derives its collections from the models the API process registers
 * (tenantDataCollections over connection.models), plus the legacy names kept in
 * migrate-tenant-data.ts. A tenant schema registered only by a module the API never loads would
 * be left out silently. This scan reads the source: every schema registered as a model
 * (MongooseModule.forFeature) whose schema carries the tenant plugin (it is registered globally,
 * so every schema that does not opt out with skipTenantPlugin) must be registered by a module
 * AppModule reaches, or have its collection in the list tenantDataCollections returns without
 * any model.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tenantDataCollections } from './migrate-tenant-data';

const SRC = path.resolve(__dirname, '../..');
const ALIASES: Record<string, string> = {
  '@infrastructure/': 'infrastructure/',
  '@shared/': 'shared/',
  '@modules/': 'modules/',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (spec.startsWith(alias)) base = path.join(SRC, target + spec.slice(alias.length));
  }
  if (!base) return null;
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source file the API's root module imports, directly or through other files. */
function reachableFrom(root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, match[1]);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

interface SchemaDeclaration {
  file: string;
  skipsTenantPlugin: boolean;
  collection?: string;
}

/** `export const XSchema = ...` per schema constant, with its opt-out and declared collection. */
function schemaDeclarations(files: string[]): Map<string, SchemaDeclaration> {
  const found = new Map<string, SchemaDeclaration>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const collection = /collection:\s*['"]([^'"]+)['"]/.exec(text)?.[1];
    for (const match of text.matchAll(/export\s+const\s+(\w+Schema)\s*=/g)) {
      const name = match[1];
      found.set(name, {
        file,
        skipsTenantPlugin: new RegExp(`${name}\\.set\\(\\s*['"]skipTenantPlugin['"]`).test(text),
        collection,
      });
    }
  }
  return found;
}

/** Schema constants passed to MongooseModule.forFeature, per file that registers them. */
function forFeatureRegistrations(files: string[]): Array<{ file: string; schema: string }> {
  const out: Array<{ file: string; schema: string }> = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const call of text.matchAll(/forFeature\(\s*\[([\s\S]*?)\]\s*\)/g)) {
      for (const entry of call[1].matchAll(/schema:\s*(\w+Schema)\b/g)) {
        out.push({ file, schema: entry[1] });
      }
    }
  }
  return out;
}

describe('POST /tenants/migrate covers every tenant schema in backend/src', () => {
  const files = sourceFiles(SRC);
  const apiFiles = reachableFrom(path.join(SRC, 'app.module.ts'));
  const declarations = schemaDeclarations(files);
  const tenantRegistrations = forFeatureRegistrations(files).filter(
    ({ schema }) => declarations.get(schema)?.skipsTenantPlugin !== true,
  );

  it('finds the registrations it checks (the scan itself works)', () => {
    const schemas = new Set(tenantRegistrations.map((r) => r.schema));
    expect(schemas.size).toBeGreaterThan(40);
    expect(schemas).toContain('IdentitySchema');
    expect(schemas).not.toContain('TenantSchema');
    // archival_records: registered by ArchivalActivitiesModule, which AppModule reaches through
    // ActivitiesModule, so the API process derives it like any other tenant model.
    const archival = tenantRegistrations.find((r) => r.schema === 'ArchivalRecordSchema');
    expect(archival && apiFiles.has(archival.file)).toBe(true);
  });

  it('leaves no tenant schema out: each is registered by the API or listed by name', () => {
    const listed = new Set(tenantDataCollections({}));
    const uncovered = tenantRegistrations
      .filter(({ file }) => !apiFiles.has(file))
      .filter(({ schema }) => {
        const collection = declarations.get(schema)?.collection;
        return !collection || !listed.has(collection);
      })
      .map(
        ({ file, schema }) =>
          `${schema} (registered in ${path.relative(SRC, file)}, which AppModule does not reach; ` +
          `name its collection in migrate-tenant-data.ts)`,
      );

    expect(uncovered).toEqual([]);
  });
});
