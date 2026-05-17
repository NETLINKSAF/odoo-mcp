// @ts-ignore — @types/node not installed
import { exec } from 'node:child_process';
// @ts-ignore — @types/node not installed; randomBytes/createHash available in Node 12+
import { createHash, randomBytes } from 'node:crypto';
// @ts-ignore — @types/node not installed
import http from 'node:http';

// ---------------------------------------------------------------------------
// Ambient declarations — avoids @types/node dependency (codebase pattern).
// ---------------------------------------------------------------------------

declare const process: {
  argv: string[];
  platform: string;
  stderr: { write: (data: string) => boolean };
  stdout: { write: (data: string) => boolean };
  exit: (code?: number) => never;
};

/** Subset of node:http.Server we actually use. */
interface NodeHttpServer {
  address(): { port: number; address: string; family: string } | string | null;
  listen(port: number, hostname: string, cb?: () => void): void;
  close(cb?: (err?: Error) => void): void;
}

/** Subset of node:http.IncomingMessage we use in the callback handler. */
interface NodeIncomingMessage {
  url?: string;
}

/** Subset of node:http.ServerResponse we use in the callback handler. */
interface NodeServerResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

// ---------------------------------------------------------------------------
// Small, testable helpers.
// ---------------------------------------------------------------------------

/** Build the OAuth 2.1 authorize URL with PKCE query params. */
export function buildAuthorizeUrl(params: {
  serverUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const { serverUrl, clientId, redirectUri, codeChallenge, state } = params;
  const base = serverUrl.replace(/\/$/, '');
  const qs = [
    'response_type=code',
    `client_id=${encodeURIComponent(clientId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `code_challenge=${encodeURIComponent(codeChallenge)}`,
    'code_challenge_method=S256',
    `state=${encodeURIComponent(state)}`,
  ].join('&');
  return `${base}/oauth/authorize?${qs}`;
}

/** Return true if the received state matches the expected state. */
export function validateState(expected: string, received: string): boolean {
  return expected === received;
}

/** Open a URL in the default browser based on the current OS. */
function openBrowser(url: string): void {
  // @ts-ignore — exec imported above
  const platform: string = process.platform;
  let cmd: string;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  // @ts-ignore — exec imported above
  exec(cmd, (err: Error | null) => {
    if (err) {
      process.stderr.write(`Warning: could not open browser: ${err.message}\n`);
    }
  });
}

// ---------------------------------------------------------------------------
// Main command.
// ---------------------------------------------------------------------------

const CALLBACK_TIMEOUT_MS = 120_000;

/** US-13 AC-7 threat-model: the local bind hostname must be exactly '127.0.0.1'. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Result returned by the internal OAuth flow on success.
 * On failure, the internal flow throws an Error with message suitable for stderr.
 */
interface OAuthFlowResult {
  accessToken: string;
  server: NodeHttpServer;
}

/**
 * Full OAuth 2.1 Authorization Code + PKCE dance against a remote MCP server.
 * Prints the resulting access token to stdout and exits 0.
 * On any error, writes to stderr and exits 1.
 *
 * process.exit is called exactly once, after the try/catch resolves,
 * so that a mocked process.exit (which may throw) cannot be caught by our own handler.
 */
export async function runAuthCommand(args: string[]): Promise<void> {
  let server: NodeHttpServer | null = null;
  let exitMessage = '';
  let exitCode = 0;
  let isSuccess = false;
  let accessToken = '';

  try {
    const result = await _runOAuthFlow(args, (s) => {
      server = s;
    });
    isSuccess = true;
    accessToken = result.accessToken;
    server = result.server;
  } catch (err) {
    exitMessage = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  // Perform I/O and cleanup outside any try/catch so process.exit(N) cannot
  // be caught and re-wrapped.
  if (isSuccess) {
    process.stdout.write(`Access token: ${accessToken}\n`);
    if (server !== null) closeServer(server);
    process.exit(0);
  } else {
    process.stderr.write(`${exitMessage}\n`);
    if (server !== null) closeServer(server);
    process.exit(exitCode);
  }
}

/**
 * Internal OAuth flow implementation.
 * Resolves with the access token on success.
 * Rejects with an Error whose message is suitable for stderr on failure.
 */
async function _runOAuthFlow(
  args: string[],
  onServer: (s: NodeHttpServer) => void,
): Promise<OAuthFlowResult> {
  // 1. Parse server URL.
  const serverUrl = args[0];
  if (!serverUrl) {
    throw new Error('Error: server URL is required');
  }

  // 2. Start local HTTP server bound exclusively to 127.0.0.1 (US-13 AC-7).
  const server = http.createServer() as NodeHttpServer;
  onServer(server);

  const port = await new Promise<number>((resolve, reject) => {
    (server as { listen: (port: number, hostname: string, cb: () => void) => void }).listen(
      0,
      LOOPBACK_HOST,
      () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('Error: unexpected server address format'));
          return;
        }
        resolve(addr.port);
      },
    );
  });

  // 3. Build redirect URI.
  const redirectUri = `http://${LOOPBACK_HOST}:${port}/callback`;

  // 4. Defensive port verification (US-13 AC-7 [threat-model]).
  const addrCheck = server.address();
  if (addrCheck === null || typeof addrCheck === 'string') {
    throw new Error('Error: could not verify bound port');
  }
  const boundPort = addrCheck.port;
  const uriPort = Number(new URL(redirectUri).port);
  if (boundPort !== uriPort) {
    throw new Error(`Error: bound port ${boundPort} does not match redirect URI port ${uriPort}`);
  }

  // 5. Dynamic Client Registration.
  let clientId: string;
  try {
    const dcrRes = await fetch(`${serverUrl.replace(/\/$/, '')}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'odoo-mcp-cli' }),
    });
    if (!dcrRes.ok) {
      const text = await dcrRes.text();
      throw new Error(`Error: DCR failed (${dcrRes.status}): ${text}`);
    }
    const dcrJson = (await dcrRes.json()) as Record<string, unknown>;
    clientId = String(dcrJson.client_id);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Error:')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Error: DCR request failed: ${msg}`);
  }

  // 6-8. Generate PKCE values and state.
  // @ts-ignore — randomBytes imported above
  const codeVerifier: string = randomBytes(32).toString('base64url');
  // @ts-ignore — createHash imported above
  const codeChallenge: string = createHash('sha256').update(codeVerifier).digest('base64url');
  // @ts-ignore — randomBytes imported above
  const state: string = randomBytes(16).toString('hex');

  // 9. Build authorize URL.
  const authorizeUrl = buildAuthorizeUrl({
    serverUrl,
    clientId,
    redirectUri,
    codeChallenge,
    state,
  });

  // 10. Open browser.
  openBrowser(authorizeUrl);

  // 11. Wait for callback with 120s timeout (US-13 AC-4).
  const callbackCode = await waitForCallback(server, state);

  // 13. Token exchange.
  const bodyParts = [
    'grant_type=authorization_code',
    `code=${encodeURIComponent(callbackCode)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `client_id=${encodeURIComponent(clientId)}`,
    `code_verifier=${encodeURIComponent(codeVerifier)}`,
  ].join('&');

  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${serverUrl.replace(/\/$/, '')}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Error: token exchange request failed: ${msg}`);
  }

  const tokenJson = (await tokenRes.json()) as Record<string, unknown>;

  // 14-15. Handle response.
  if (tokenRes.ok && typeof tokenJson.access_token === 'string') {
    return { accessToken: tokenJson.access_token as string, server };
  }
  const errDesc = tokenJson.error_description ?? JSON.stringify(tokenJson);
  throw new Error(String(errDesc));
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Gracefully close the HTTP server (ignores errors). */
function closeServer(server: NodeHttpServer): void {
  server.close(() => {
    // intentionally empty
  });
}

/**
 * Wait for a GET /callback?code=<code>&state=<state> request.
 * Resolves with the authorization code or rejects on timeout / state mismatch.
 */
function waitForCallback(server: NodeHttpServer, expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Timeout guard (US-13 AC-4).
    const timer = setTimeout(() => {
      reject(new Error('Timeout: no authorization response received'));
    }, CALLBACK_TIMEOUT_MS);

    // Register the request handler.
    (server as unknown as { on: (event: string, handler: (...a: unknown[]) => void) => void }).on(
      'request',
      (...a: unknown[]) => {
        const req = a[0] as NodeIncomingMessage;
        const res = a[1] as NodeServerResponse;
        const rawUrl = req.url ?? '';
        // Only handle /callback
        if (!rawUrl.startsWith('/callback')) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const parsed = new URL(rawUrl, `http://${LOOPBACK_HOST}`);
        const code = parsed.searchParams.get('code');
        const receivedState = parsed.searchParams.get('state');

        // 12. State mismatch check.
        if (!receivedState || !validateState(expectedState, receivedState)) {
          clearTimeout(timer);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body>State mismatch — possible CSRF. You may close this window.</body></html>',
          );
          reject(new Error('State mismatch — possible CSRF'));
          return;
        }

        if (!code) {
          clearTimeout(timer);
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body>Missing authorization code. You may close this window.</body></html>',
          );
          reject(new Error('Error: missing authorization code in callback'));
          return;
        }

        // Success — send browser a friendly page.
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization successful.</h1><p>You may close this window.</p></body></html>',
        );
        resolve(code);
      },
    );
  });
}
