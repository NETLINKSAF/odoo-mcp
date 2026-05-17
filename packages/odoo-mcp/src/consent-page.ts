/** HTML-escape a string to prevent XSS. */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  *,*::before,*::after{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;padding:2rem 1rem}
  .container{max-width:420px;margin:0 auto;background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
  h1{margin:0 0 1.5rem;font-size:1.4rem}
  label{display:block;margin-bottom:.25rem;font-size:.9rem;font-weight:500}
  input{display:block;width:100%;padding:.5rem .75rem;margin-bottom:1rem;border:1px solid #ccc;border-radius:4px;font-size:1rem}
  button{width:100%;padding:.6rem;background:#1a56db;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
  button:hover{background:#1648c0}
  .error{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:.5rem .75rem;margin-bottom:1rem}
  p.hint{font-size:.85rem;color:#555;margin-top:1.25rem}
`.trim();

export function renderConsentPage(params: {
  client_name?: string;
  error?: string;
  email?: string;
  formAction: string;
}): string {
  const { client_name, error, email, formAction } = params;
  const title =
    client_name != null && client_name !== ''
      ? `Authorize ${escapeHtml(client_name)}`
      : 'Authorize MCP Client';

  const errorHtml =
    error != null ? `<p class="error" role="alert">${escapeHtml(error)}</p>\n  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    ${errorHtml}<form method="POST" action="${escapeHtml(formAction)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required value="${escapeHtml(email ?? '')}" autofocus>
      <label for="api_key">API Key</label>
      <input type="password" id="api_key" name="api_key" required>
      <button type="submit">Authorize</button>
    </form>
    <p class="hint">Enter your Odoo email and API key to grant this client access via your identity.</p>
  </div>
</body>
</html>`;
}

export function renderErrorPage(params: { title: string; message: string }): string {
  const { title, message } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
