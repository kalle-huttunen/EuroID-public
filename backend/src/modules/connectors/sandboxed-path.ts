import * as fs from 'fs';
import * as path from 'path';

/**
 * The real path of `target` (symlinks resolved). For a path that does not exist, the real path
 * of its nearest existing parent with the rest appended, so a missing file behind a symlink that
 * leads outside is refused like an existing one.
 */
export function realpathOfExisting(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) throw err;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * `filePath` (relative to `allowedDir`, or absolute) as a real path inside the real path of
 * `allowedDir`, or undefined when it leads outside (`..`, an absolute path elsewhere, a symlink).
 * Throws when a path cannot be resolved (a permission error on the way).
 */
export function realpathInside(allowedDir: string, filePath: string): string | undefined {
  const root = fs.realpathSync(path.resolve(allowedDir));
  const resolved = realpathOfExisting(path.resolve(root, filePath));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
}
