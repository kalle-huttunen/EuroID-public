/**
 * Escapes regex metacharacters to prevent ReDoS when using user input in $regex.
 * Escapes: . * + ? ^ $ { } ( ) | [ ] \
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- TASK_104 recap: ReDoS-safe escape for user input in $regex. Used by audit actor filter.
