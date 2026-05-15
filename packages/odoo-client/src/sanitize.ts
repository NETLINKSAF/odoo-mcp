const PII_KEY_PATTERN = /password|credit_card|token|secret|api_key/i;

const SANITIZED_TOOLS = new Set<string>(['odoo_create', 'odoo_write']);

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

export function sanitizeArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!SANITIZED_TOOLS.has(toolName)) {
    return args;
  }

  const cloned = structuredClone(args);

  const values = cloned['values'];
  if (values === null || typeof values !== 'object') {
    return cloned;
  }

  if (Array.isArray(values)) {
    for (const item of values) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        redactObject(item as Record<string, unknown>);
      }
    }
  } else {
    redactObject(values as Record<string, unknown>);
  }

  return cloned;
}
