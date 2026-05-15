// Key-name pattern that marks a value as PII; matched case-insensitively against
// every object key in the args tree. Adjust here if Odoo introduces new
// credential-bearing field names.
const PII_KEY_PATTERN = /password|credit_card|token|secret|api_key/i;

// Tools whose args may carry user-supplied credentials and so require deep
// redaction before being passed to logger.toolCall. Other tools (read,
// search_read, fields_get, etc.) take only domains/ids/fields and don't
// need sanitisation, so we skip the structuredClone for them.
const SANITIZED_TOOLS = new Set<string>([
  'odoo_create',
  'odoo_write',
  'odoo_execute',
  'odoo_call_action',
]);

function redactObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (PII_KEY_PATTERN.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          redactObject(item as Record<string, unknown>);
        }
      }
    }
  }
}

/**
 * Returns a sanitised copy of `args` with any PII-shaped keys replaced by
 * `'[REDACTED]'`. For tools not in SANITIZED_TOOLS the original args reference
 * is returned unchanged (no clone, no traversal). For sanitised tools the
 * args are deep-cloned via structuredClone, then the clone is traversed
 * recursively and any key matching PII_KEY_PATTERN has its value redacted.
 *
 * Used to build the `args_sanitized` field passed to `logger.toolCall` so
 * that log lines never contain raw credentials (US-9 AC-3).
 *
 * @param toolName The MCP tool name (e.g. 'odoo_create'). Determines whether
 *   redaction applies — tools that only accept domains/ids are skipped.
 * @param args The original tool args. NEVER mutated regardless of branch.
 * @returns Either the original args object (when no redaction needed) or a
 *   deep-cloned and sanitised copy.
 */
export function sanitizeArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!SANITIZED_TOOLS.has(toolName)) {
    return args;
  }

  const cloned = structuredClone(args);
  redactObject(cloned);
  return cloned;
}
