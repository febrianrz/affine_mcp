#!/usr/bin/env tsx
import assert from "node:assert/strict";

import {
  isHostAllowed,
  parseTenantAllowedHosts,
  resolveTenantFromHeaders,
  TenantError,
} from "../src/tenant.ts";

const options = {
  allowedHosts: parseTenantAllowedHosts("affine.example.com, *.team.example.org"),
  allowInsecureHttp: false,
  graphqlPath: "/graphql",
};
const base = {
  "x-affine-url": "https://affine.example.com",
  "x-affine-email": "a@example.com",
  "x-affine-password": "pw",
};

function rejects(headers, status, pattern, opts = options) {
  assert.throws(
    () => resolveTenantFromHeaders(headers, opts),
    (error) => error instanceof TenantError && error.status === status && pattern.test(error.message),
  );
}

// allowlist parsing and matching
assert.deepEqual(options.allowedHosts, ["affine.example.com", "*.team.example.org"]);
assert.throws(() => parseTenantAllowedHosts("*"), /bare wildcard/);
assert.throws(() => parseTenantAllowedHosts("evil*.com"), /Invalid/);
assert.equal(isHostAllowed("affine.example.com", options.allowedHosts), true);
assert.equal(isHostAllowed("AFFINE.example.com.", options.allowedHosts), true);
assert.equal(isHostAllowed("a.team.example.org", options.allowedHosts), true);
assert.equal(isHostAllowed("team.example.org", options.allowedHosts), false, "wildcard excludes apex");
assert.equal(isHostAllowed("affine.example.com.evil.io", options.allowedHosts), false);
assert.equal(isHostAllowed("evilaffine.example.com", options.allowedHosts), false);

// happy paths
const pw = resolveTenantFromHeaders(base, options);
assert.equal(pw.baseUrl, "https://affine.example.com");
assert.equal(pw.graphqlEndpoint, "https://affine.example.com/graphql");
assert.deepEqual(pw.auth, { kind: "password", email: "a@example.com", password: "pw" });

const b64 = resolveTenantFromHeaders({
  "x-affine-url": "https://x.team.example.org/",
  "x-affine-email": "a@example.com",
  "x-affine-password-b64": Buffer.from("pässwörd", "utf8").toString("base64"),
  "x-affine-workspace-id": "ws_123-abc",
}, options);
assert.equal(b64.auth.password, "pässwörd");
assert.equal(b64.workspaceId, "ws_123-abc");

assert.deepEqual(
  resolveTenantFromHeaders({ "x-affine-url": base["x-affine-url"], "x-affine-cookie": "a=b" }, options).auth,
  { kind: "cookie", cookie: "a=b" },
);
assert.deepEqual(
  resolveTenantFromHeaders({ "x-affine-url": base["x-affine-url"], "x-affine-token": "tok" }, options).auth,
  { kind: "bearer", token: "tok" },
);

// rejections
rejects(base, 403, /no allowed AFFiNE hosts/, { ...options, allowedHosts: [] });
rejects({ ...base, "x-affine-url": undefined }, 400, /Missing X-Affine-Url/);
rejects({ ...base, "x-affine-url": "https://evil.example.net" }, 403, /not in the allowlist/);
rejects({ ...base, "x-affine-url": "http://affine.example.com" }, 400, /HTTPS/);
rejects({ ...base, "x-affine-url": "https://u:p@affine.example.com" }, 400, /embedded credentials/);
rejects({ ...base, "x-affine-url": "ftp://affine.example.com" }, 400, /scheme/);
rejects({ ...base, "x-affine-url": "https://affine.example.com@evil.net" }, 400, /embedded credentials/);
rejects({ ...base, "x-affine-email": undefined }, 400, /together/);
rejects({ ...base, "x-affine-password": undefined }, 400, /together/);
rejects({ ...base, "x-affine-cookie": "a=b" }, 400, /exactly one/);
rejects({ "x-affine-url": base["x-affine-url"] }, 400, /exactly one/);
rejects({ ...base, "x-affine-password": "p\r\nX: y" }, 400, /illegal/);
rejects({ ...base, "x-affine-password-b64": "cHc=" }, 400, /not both/);
rejects({ ...base, "x-affine-email": ["a@x.com", "b@x.com"] }, 400, /repeated/);
rejects({ ...base, "x-affine-workspace-id": "../etc" }, 400, /Invalid X-Affine-Workspace-Id/);
rejects({ ...base, "x-affine-password": "x".repeat(2000) }, 400, /too long/);

// insecure HTTP only with the explicit opt-in
assert.equal(
  resolveTenantFromHeaders({ ...base, "x-affine-url": "http://affine.example.com" }, { ...options, allowInsecureHttp: true }).baseUrl,
  "http://affine.example.com",
);

console.log("tenant tests passed");
