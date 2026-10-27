#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { startHttpMcpServer } from "../src/sse.ts";

const config = {
  baseUrl: "http://127.0.0.1:3010",
  graphqlEndpoint: "http://127.0.0.1:3010/graphql",
  graphqlPath: "/graphql",
  authMode: "bearer",
  oauthScopes: ["mcp"],
  oauthClockSkewSeconds: 60,
  transportMode: "http",
  loginAtStart: "async",
  http: { host: "127.0.0.1", port: 0, allowedOrigins: [], allowAllOrigins: false },
  oauthAllowServiceWrites: false,
  multiTenant: false,
  publicBaseUrl: "https://mcp.example.com",
};
const create = async () => new McpServer({ name: "docs-test", version: "1.0.0" });

async function withServer(env, run) {
  const previous = process.env.AFFINE_MCP_DOCS;
  if (env === undefined) delete process.env.AFFINE_MCP_DOCS;
  else process.env.AFFINE_MCP_DOCS = env;
  const handle = await startHttpMcpServer(create, config);
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.AFFINE_MCP_DOCS;
    else process.env.AFFINE_MCP_DOCS = previous;
  }
}

await withServer(undefined, async (base) => {
  const page = await fetch(`${base}/docs`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /api-reference/);

  for (const route of ["/openapi.json", "/docs/openapi.json"]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, route);
    const spec = await response.json();
    assert.match(spec.openapi, /^3\.1/);
    assert.equal(spec.servers[0].variables.baseUrl.default, "https://mcp.example.com", "public URL is applied");
  }
});

await withServer("false", async (base) => {
  assert.equal((await fetch(`${base}/docs`)).status, 404);
  assert.equal((await fetch(`${base}/openapi.json`)).status, 404);
});

console.log("docs routes tests passed");
