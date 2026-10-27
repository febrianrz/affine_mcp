import { validateBaseUrl, validateGraphqlPath } from "./config.js";

/**
 * Multi-tenant mode: one MCP deployment serves many AFFiNE users on many
 * AFFiNE domains. Each MCP session carries its own destination and credentials
 * in the headers of the `initialize` request:
 *
 *   X-Affine-Url                AFFiNE base URL (host must be allowlisted)
 *   X-Affine-Email              \ email + password (renewed automatically), or
 *   X-Affine-Password[-B64]     /
 *   X-Affine-Cookie             a signed-in session Cookie header, or
 *   X-Affine-Token              a bearer token accepted by the AFFiNE server
 *   X-Affine-Workspace-Id       optional default workspace
 *
 * `Authorization: Bearer <AFFINE_MCP_HTTP_TOKEN>` still authenticates the
 * calling application to this gateway and is never forwarded to AFFiNE.
 */

export class TenantError extends Error {
  constructor(readonly status: 400 | 401 | 403, message: string) {
    super(message);
    this.name = "TenantError";
  }
}

export type TenantAuth =
  | { kind: "password"; email: string; password: string }
  | { kind: "cookie"; cookie: string }
  | { kind: "bearer"; token: string };

export type TenantContext = {
  baseUrl: string;
  graphqlEndpoint: string;
  workspaceId?: string;
  auth: TenantAuth;
};

export type TenantResolveOptions = {
  allowedHosts: readonly string[];
  allowInsecureHttp: boolean;
  graphqlPath: string;
};

const MAX_URL = 2048;
const MAX_EMAIL = 320;
const MAX_PASSWORD = 1024;
const MAX_COOKIE = 8192;
const MAX_TOKEN = 4096;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parse `AFFINE_MCP_TENANT_ALLOWED_HOSTS`: comma-separated hostnames, exact
 * (`affine.example.com`) or one-level-and-deeper wildcard (`*.example.com`,
 * which does not match the apex). A bare `*` is rejected: this server sends
 * user credentials to the destination, so an open allowlist would be a
 * credential-forwarding proxy.
 */
export function parseTenantAllowedHosts(raw: string | undefined): string[] {
  const hosts = (raw || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
  for (const host of hosts) {
    if (host === "*" || host === "*." || /^\*\.?$/.test(host)) {
      throw new Error("AFFINE_MCP_TENANT_ALLOWED_HOSTS must not contain a bare wildcard.");
    }
    if (host.includes("*") && !/^\*\.[a-z0-9.-]+$/.test(host)) {
      throw new Error(
        `Invalid AFFINE_MCP_TENANT_ALLOWED_HOSTS entry "${host}": wildcards are only allowed as a leading "*.".`,
      );
    }
  }
  return hosts;
}

export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((pattern) =>
    pattern.startsWith("*.")
      ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
      : host === pattern,
  );
}

type HeaderBag = Record<string, string | string[] | undefined>;

function single(headers: HeaderBag, name: string, max: number): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    throw new TenantError(400, `Header ${name} must not be repeated.`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new TenantError(400, `Header ${name} contains illegal characters.`);
  }
  if (value.length > max) {
    throw new TenantError(400, `Header ${name} is too long.`);
  }
  return value;
}

export function resolveTenantFromHeaders(
  headers: HeaderBag,
  options: TenantResolveOptions,
): TenantContext {
  if (options.allowedHosts.length === 0) {
    throw new TenantError(
      403,
      "Multi-tenant mode has no allowed AFFiNE hosts configured (AFFINE_MCP_TENANT_ALLOWED_HOSTS).",
    );
  }

  const rawUrl = single(headers, "x-affine-url", MAX_URL)?.trim();
  if (!rawUrl) throw new TenantError(400, "Missing X-Affine-Url header.");

  let baseUrl: string;
  let hostname: string;
  try {
    baseUrl = validateBaseUrl(rawUrl, {
      allowInsecureHttp: options.allowInsecureHttp,
      insecureHttpOptInName: "AFFINE_ALLOW_INSECURE_HTTP",
      label: "X-Affine-Url",
    });
    hostname = new URL(baseUrl).hostname;
  } catch (error) {
    throw new TenantError(400, error instanceof Error ? error.message : "Invalid X-Affine-Url.");
  }
  if (!isHostAllowed(hostname, options.allowedHosts)) {
    throw new TenantError(403, `AFFiNE host "${hostname}" is not in the allowlist.`);
  }

  const email = single(headers, "x-affine-email", MAX_EMAIL)?.trim();
  const passwordPlain = single(headers, "x-affine-password", MAX_PASSWORD);
  const passwordB64 = single(headers, "x-affine-password-b64", MAX_PASSWORD * 2);
  const cookie = single(headers, "x-affine-cookie", MAX_COOKIE)?.trim();
  const token = single(headers, "x-affine-token", MAX_TOKEN)?.trim();

  let password = passwordPlain;
  if (passwordB64 !== undefined) {
    if (passwordPlain !== undefined) {
      throw new TenantError(400, "Send either X-Affine-Password or X-Affine-Password-B64, not both.");
    }
    password = Buffer.from(passwordB64, "base64").toString("utf8");
  }

  const hasPassword = Boolean(email) || Boolean(password);
  const methods = [hasPassword, Boolean(cookie), Boolean(token)].filter(Boolean).length;
  if (methods !== 1) {
    throw new TenantError(
      400,
      "Provide exactly one credential: X-Affine-Email with X-Affine-Password, or X-Affine-Cookie, or X-Affine-Token.",
    );
  }

  let auth: TenantAuth;
  if (hasPassword) {
    if (!email || !password) {
      throw new TenantError(400, "X-Affine-Email and X-Affine-Password must be provided together.");
    }
    auth = { kind: "password", email, password };
  } else if (cookie) {
    auth = { kind: "cookie", cookie };
  } else {
    auth = { kind: "bearer", token: token! };
  }

  const workspaceId = single(headers, "x-affine-workspace-id", 64)?.trim() || undefined;
  if (workspaceId && !WORKSPACE_ID.test(workspaceId)) {
    throw new TenantError(400, "Invalid X-Affine-Workspace-Id.");
  }

  return {
    baseUrl,
    graphqlEndpoint: `${baseUrl}${validateGraphqlPath(options.graphqlPath)}`,
    workspaceId,
    auth,
  };
}
