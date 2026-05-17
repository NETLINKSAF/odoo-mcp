// Minimal ambient declaration — avoids @types/node dependency.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: { write: (data: string) => boolean };
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
};

/**
 * Parse a flat args array for --flag <value> pairs.
 * Returns the value for the given flag name, or undefined if absent.
 */
function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Pretty-print JSON if the text is valid JSON, otherwise return it as-is.
 */
function formatBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * CLI subcommand for the operator to manage allowlisted MCP users on a remote
 * MCP server. Dispatches to GET/POST/DELETE /admin/users endpoints.
 *
 * Usage:
 *   list    --url <server_url> [--password <pwd>]
 *   allow   <email> --url <server_url> [--password <pwd>]
 *   revoke  <email> --url <server_url> [--password <pwd>]
 */
export async function runUsersCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  // --- Validate subcommand ---
  if (subcommand !== 'list' && subcommand !== 'allow' && subcommand !== 'revoke') {
    const name = subcommand ?? '';
    process.stderr.write(`Error: unknown subcommand: ${name}. Expected: list, allow, revoke\n`);
    process.exit(1);
  }

  // --- Parse --url ---
  const url = parseFlag(args, '--url');
  if (url === undefined) {
    process.stderr.write('Error: --url is required\n');
    process.exit(1);
  }

  // --- Parse --password / fallback to env ---
  const password = parseFlag(args, '--password') ?? process.env.MCP_ADMIN_PASSWORD;
  if (password === undefined || password === '') {
    process.stderr.write('Error: MCP_ADMIN_PASSWORD not set and --password not provided\n');
    process.exit(1);
  }

  // --- Parse email (required for allow / revoke) ---
  let email: string | undefined;
  if (subcommand === 'allow' || subcommand === 'revoke') {
    // Email is positional: the argument immediately after the subcommand name,
    // provided it does not start with '--'.
    const candidate = args[1];
    if (candidate === undefined || candidate.startsWith('--')) {
      process.stderr.write('Error: email argument required\n');
      process.exit(1);
    }
    email = candidate;
  }

  // --- Build request parameters ---
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${password}`,
  };

  let fetchUrl: string;
  let method: string;
  let body: string | undefined;
  let extraHeaders: Record<string, string> = {};

  if (subcommand === 'list') {
    fetchUrl = `${url}/admin/users`;
    method = 'GET';
  } else if (subcommand === 'allow') {
    fetchUrl = `${url}/admin/users`;
    method = 'POST';
    body = JSON.stringify({ email });
    extraHeaders = { 'Content-Type': 'application/json' };
  } else {
    // revoke
    fetchUrl = `${url}/admin/users/${encodeURIComponent(email as string)}`;
    method = 'DELETE';
  }

  // --- Execute request ---
  let response: Awaited<ReturnType<typeof globalThis.fetch>>;
  try {
    response = await globalThis.fetch(fetchUrl, {
      method,
      headers: { ...authHeaders, ...extraHeaders },
      ...(body !== undefined ? { body } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Network error: ${message}\n`);
    process.exit(1);
  }

  const text = await response.text();

  if (response.ok) {
    process.stdout.write(`${formatBody(text)}\n`);
  } else {
    process.stderr.write(`${text}\n`);
    process.exit(1);
  }
}
