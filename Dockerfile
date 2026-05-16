FROM node:22-alpine

# Enable pnpm via corepack (built into Node 22)
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy manifests and lockfile first — Docker layer cache optimization
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/odoo-client/package.json packages/odoo-client/
COPY packages/odoo-mcp/package.json packages/odoo-mcp/

# Install all deps (frozen — no silent lockfile drift)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Compile TypeScript for both packages
RUN pnpm -r build

# Default to HTTP mode (Docker implies remote access — US-5 AC-4)
ENV MODE=http
ENV MCP_PORT=3000

EXPOSE 3000

ENTRYPOINT ["node", "packages/odoo-mcp/dist/bin.js"]
