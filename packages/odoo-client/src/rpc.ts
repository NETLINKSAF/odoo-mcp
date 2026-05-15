import {
  OdooAccessError,
  OdooAuthError,
  OdooConnectionError,
  OdooError,
  OdooMissingError,
  OdooUserError,
  OdooValidationError,
} from './errors.js';

/**
 * Per-request abort threshold. Aligned with Odoo's typical worker timeout
 * envelope; longer waits indicate the request is unrecoverable rather than slow.
 * US-8 AC-7.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Wire shape of a single Odoo JSON-RPC request envelope. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: 'call';
  id: number;
  params: Record<string, unknown>;
}

/** Wire shape of an Odoo JSON-RPC response envelope. Exactly one of `result`/`error` is populated. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data: { name: string; message: string; debug: string };
  };
}

let _requestId = 0;

function nextId(): number {
  return ++_requestId;
}

const ERROR_MAP: Record<
  string,
  new (
    message: string,
    model?: string,
    method?: string,
    traceback?: string,
  ) => OdooError
> = {
  'odoo.exceptions.UserError': OdooUserError,
  'odoo.exceptions.ValidationError': OdooValidationError,
  'odoo.exceptions.AccessError': OdooAccessError,
  'odoo.exceptions.MissingError': OdooMissingError,
};

/**
 * Single-request transport for Odoo's JSON-RPC stdio surface. Composes the
 * envelope, posts to `${url}${endpoint}`, applies REQUEST_TIMEOUT_MS, and maps
 * server faults onto the typed OdooError hierarchy. Caller passes optional
 * `headers` for cookie/session-id injection.
 */
export async function jsonRpc(
  url: string,
  endpoint: string,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const id = nextId();

  const body: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: 'call',
    id,
    params,
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutHandle);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OdooConnectionError('Request timeout after 30s');
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new OdooConnectionError(message);
  }

  clearTimeout(timeoutHandle);

  const json = (await response.json()) as JsonRpcResponse;

  if (json.error) {
    const { name, message, debug } = json.error.data;

    if (name === 'odoo.exceptions.AccessDenied') {
      throw new OdooAuthError(message, debug);
    }

    const ErrorClass = ERROR_MAP[name];
    if (ErrorClass) {
      throw new ErrorClass(message, undefined, undefined, debug);
    }

    throw new OdooError('ServerError', message, undefined, undefined, debug);
  }

  return json.result;
}
