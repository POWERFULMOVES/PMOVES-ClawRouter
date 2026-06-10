import type { OpenClawConfig } from "./types.js";

export const BLOCKRUN_MCP_SERVER_NAME = "blockrun";
const BLOCKRUN_MCP_NPM_SPEC = "@blockrun/mcp@latest";
const BLOCKRUN_MCP_DEFAULT_TIMEOUT_MS = 30_000;

export type McpServerDefinition = Record<string, unknown> & {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  transport?: string;
  headers?: Record<string, string>;
  connectionTimeoutMs?: number;
};

export type EnsureBlockrunMcpServerResult = {
  changed: boolean;
  status: "added" | "updated" | "unchanged" | "preserved";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === "string";
  });
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function normalizeServerDefinition(server: McpServerDefinition): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of ["command", "url", "transport", "cwd", "connectionTimeoutMs"] as const) {
    const value = server[key];
    if (value !== undefined) normalized[key] = value;
  }

  if (isStringArray(server.args)) {
    normalized.args = [...server.args];
  }

  const env = normalizeStringRecord(server.env);
  if (env) normalized.env = env;

  const headers = normalizeStringRecord(server.headers);
  if (headers) normalized.headers = headers;

  return normalized;
}

function looksLikeBlockrunPackageArgs(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("@blockrun/mcp"));
}

function looksLikeLocalBlockrunDistArgs(args: string[]): boolean {
  return args.some((arg) => arg.replaceAll("\\", "/").endsWith("/blockrun-mcp/dist/index.js"));
}

export function createBlockrunMcpServerDefinition(opts?: {
  localDistPath?: string;
  cwd?: string;
  nodeCommand?: string;
  connectionTimeoutMs?: number;
}): McpServerDefinition {
  const connectionTimeoutMs = opts?.connectionTimeoutMs ?? BLOCKRUN_MCP_DEFAULT_TIMEOUT_MS;
  if (opts?.localDistPath) {
    return {
      command: opts.nodeCommand ?? process.execPath,
      args: [opts.localDistPath],
      cwd: opts.cwd,
      connectionTimeoutMs,
    };
  }

  return {
    command: "npx",
    args: ["-y", BLOCKRUN_MCP_NPM_SPEC],
    connectionTimeoutMs,
  };
}

function isManagedBlockrunMcpServerDefinition(value: unknown): value is McpServerDefinition {
  if (!isRecord(value)) return false;
  const args = isStringArray(value.args) ? value.args : [];
  if (typeof value.command === "string" && value.command === "npx") {
    return looksLikeBlockrunPackageArgs(args);
  }
  return looksLikeLocalBlockrunDistArgs(args);
}

export function ensureBlockrunMcpServerConfig(
  config: OpenClawConfig,
  desiredServer: McpServerDefinition,
): EnsureBlockrunMcpServerResult {
  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    config.mcp = {};
  }
  const mcp = config.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== "object" || Array.isArray(mcp.servers)) {
    mcp.servers = {};
  }
  const servers = mcp.servers as Record<string, unknown>;
  const existing = servers[BLOCKRUN_MCP_SERVER_NAME];

  if (!existing) {
    servers[BLOCKRUN_MCP_SERVER_NAME] = desiredServer;
    return { changed: true, status: "added" };
  }

  if (!isRecord(existing)) {
    servers[BLOCKRUN_MCP_SERVER_NAME] = desiredServer;
    return { changed: true, status: "updated" };
  }

  if (!isManagedBlockrunMcpServerDefinition(existing)) {
    return { changed: false, status: "preserved" };
  }

  const existingNormalized = JSON.stringify(normalizeServerDefinition(existing));
  const desiredNormalized = JSON.stringify(normalizeServerDefinition(desiredServer));
  if (existingNormalized === desiredNormalized) {
    return { changed: false, status: "unchanged" };
  }

  servers[BLOCKRUN_MCP_SERVER_NAME] = desiredServer;
  return { changed: true, status: "updated" };
}

export function removeManagedBlockrunMcpServerConfig(config: OpenClawConfig): boolean {
  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    return false;
  }
  const mcp = config.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== "object" || Array.isArray(mcp.servers)) {
    return false;
  }
  const servers = mcp.servers as Record<string, unknown>;
  if (!isManagedBlockrunMcpServerDefinition(servers[BLOCKRUN_MCP_SERVER_NAME])) {
    return false;
  }

  delete servers[BLOCKRUN_MCP_SERVER_NAME];
  if (Object.keys(servers).length === 0) {
    delete mcp.servers;
  }
  if (Object.keys(mcp).length === 0) {
    delete config.mcp;
  }
  return true;
}
