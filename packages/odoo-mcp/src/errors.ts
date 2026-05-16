import type { OdooError } from '@netlinksinc/odoo-client';

declare const process: { env: Record<string, string | undefined> };

export interface McpToolError {
  error_type: string;
  message: string;
  model?: string;
  method?: string;
  traceback?: string;
}

export function formatMcpError(error: OdooError): McpToolError {
  const result: McpToolError = {
    error_type: error.errorType,
    message: error.message,
  };
  if (error.model !== undefined) result.model = error.model;
  if (error.method !== undefined) result.method = error.method;
  if (process.env.ODOO_MCP_DEBUG === '1' && error.traceback !== undefined) {
    result.traceback = error.traceback;
  }
  return result;
}
