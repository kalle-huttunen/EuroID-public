/**
 * Options of the audit log's Target system filter. The filter matches `targetSystem` exactly, so
 * the options are every registered connector (GET /connectors/available, labelled by its name)
 * plus any other system name the loaded page shows (an event may name a system by another
 * spelling) and the value the filter already holds, so a chosen system never drops out of the
 * list when the filtered page no longer shows it.
 */
export interface TargetSystemOption {
  value: string;
  label: string;
}

export function targetSystemOptions(
  connectors: ReadonlyArray<{ id: string; name: string }>,
  pageSystems: ReadonlyArray<string | undefined>,
  selected?: string,
): TargetSystemOption[] {
  const options = new Map<string, string>();
  for (const { id, name } of connectors) options.set(id, name || id);
  for (const system of [...pageSystems, selected]) {
    if (system && !options.has(system)) options.set(system, system);
  }
  return Array.from(options, ([value, label]) => ({ value, label })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
