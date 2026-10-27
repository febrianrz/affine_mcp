#!/usr/bin/env node
// Generates docs/openapi.json from the real server: it starts dist/index.js in
// multi-tenant mode against a throwaway fake AFFiNE, lists the tools over MCP,
// and renders the gateway API plus every tool's input/output schema.
//
//   npm run build && npm run docs:openapi
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "openapi.json");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const GATEWAY_TOKEN = "docs-generator-token";

// Top-level group per tool, read from the source of truth in toolSurface.ts.
function loadToolGroups() {
  const source = readFileSync(path.join(ROOT, "src", "toolSurface.ts"), "utf8");
  const start = source.indexOf("const TOOL_GROUPS");
  const end = source.indexOf("\n};", start);
  const groups = new Map();
  for (const match of source.slice(start, end).matchAll(/^\s+([a-z_0-9]+): \["([a-z]+)"/gm)) {
    groups.set(match[1], match[2]);
  }
  return groups;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function listTools() {
  const fake = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/api/auth/sign-in") {
      res.writeHead(200, { "Set-Cookie": "affine_session=docs; Path=/; Max-Age=3600" }).end("{}");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: {} }));
    }
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  const child = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT: "http",
      PORT: String(port),
      AFFINE_MCP_HTTP_HOST: "127.0.0.1",
      AFFINE_MCP_HTTP_TOKEN: GATEWAY_TOKEN,
      AFFINE_MCP_MULTI_TENANT: "true",
      AFFINE_MCP_TENANT_ALLOWED_HOSTS: "127.0.0.1",
      XDG_CONFIG_HOME: "/nonexistent",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${endpoint}/healthz`)).ok) break;
      } catch {}
      if (i > 100) throw new Error("server did not start; run `npm run build` first");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${GATEWAY_TOKEN}`,
    };
    const rpc = async (extra, body) => {
      const response = await fetch(`${endpoint}/mcp`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      return { response, json: JSON.parse(line ? line.slice(5) : text) };
    };
    const init = await rpc(
      {
        "x-affine-url": `http://127.0.0.1:${fake.address().port}`,
        "x-affine-email": "docs@example.com",
        "x-affine-password": "docs",
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "docs", version: "1" } },
      },
    );
    const sid = init.response.headers.get("mcp-session-id");
    if (!sid) throw new Error("initialize failed");
    const session = { "mcp-session-id": sid };
    await rpc(session, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    const tools = [];
    let cursor;
    do {
      const { json } = await rpc(session, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      });
      tools.push(...json.result.tools);
      cursor = json.result.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    child.kill();
    fake.close();
  }
}

const STRIP = new Set(["$schema"]);
// Tool schemas use root-relative refs ("#/properties/docId"). Once embedded in the
// OpenAPI document they must point at where that schema now lives.
function cleanSchema(schema, base) {
  if (Array.isArray(schema)) return schema.map((item) => cleanSchema(item, base));
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => !STRIP.has(key))
        .map(([key, value]) => [
          key,
          key === "$ref" && typeof value === "string" && value.startsWith("#/")
            ? `${base}${value.slice(1)}`
            : cleanSchema(value, base),
        ]),
    );
  }
  return schema;
}

const JSON_CONTENT = "content/application~1json/schema";

const GROUP_TITLES = {
  docs: "Documents",
  workspaces: "Workspaces",
  organize: "Organize (folders, collections, tags)",
  comments: "Comments",
  blobs: "Blobs and files",
  notifications: "Notifications",
  users: "Users and settings",
  history: "History",
};

const rpcErrorResponses = {
  "400": { description: "Missing/invalid tenant headers (initialize) or malformed JSON-RPC." },
  "401": { description: "Wrong gateway token, or AFFiNE sign-in failed for the supplied credentials." },
  "403": { description: "The AFFiNE host is not in `AFFINE_MCP_TENANT_ALLOWED_HOSTS`." },
};

function buildSpec(tools, groups) {
  const tenantHeader = (name, description, extra = {}) => ({
    name,
    in: "header",
    required: false,
    description,
    schema: { type: "string", ...extra },
  });

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "AFFiNE MCP Gateway",
      version: pkg.version,
      summary: "Multi-tenant Model Context Protocol server for self-hosted AFFiNE.",
      description: [
        "One deployment, many AFFiNE users and domains. Your application opens an MCP session per user over",
        "Streamable HTTP (`POST /mcp`) and then calls tools with JSON-RPC.",
        "",
        "## Flow",
        "1. `POST /mcp` with `method: initialize`, the gateway token in `Authorization`, and the user's AFFiNE",
        "   destination and credentials in `X-Affine-*` headers. The response carries an `Mcp-Session-Id` header.",
        "2. Send `notifications/initialized`, then `tools/list` or `tools/call` with the same `Mcp-Session-Id`.",
        "   `X-Affine-*` headers are only read on `initialize` and are ignored afterwards.",
        "3. `DELETE /mcp` with the session id when done. Idle sessions close automatically.",
        "",
        "## Tools",
        `The ${tools.length} tools below are generated from the running server. They are MCP tools, not separate`,
        "HTTP endpoints: each is invoked as `tools/call` on `POST /mcp` with `params.name` and `params.arguments`.",
        "They appear in the **Webhooks** section purely because OpenAPI has no native notion of JSON-RPC methods.",
        "",
        "## Credits",
        "Based on [affine-mcp-server](https://github.com/DAWNCR0W/affine-mcp-server) by DAWNCR0W (MIT).",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      {
        url: "{baseUrl}",
        description: "Your deployment (for example the Dokploy domain).",
        variables: { baseUrl: { default: "http://localhost:3000" } },
      },
    ],
    security: [{ gatewayToken: [] }],
    tags: [
      { name: "Gateway", description: "Session lifecycle and diagnostics." },
      ...Object.entries(GROUP_TITLES).map(([name, description]) => ({ name: description, description: `Tools: ${name}` })),
    ],
    paths: {
      "/mcp": {
        post: {
          tags: ["Gateway"],
          operationId: "mcpRequest",
          summary: "JSON-RPC request (initialize, tools/list, tools/call, ...)",
          description:
            "Streamable HTTP MCP endpoint. The first request of a session must be `initialize` and must include the tenant headers. Later requests must send `Mcp-Session-Id`. Responses are JSON or an SSE stream (`Accept: application/json, text/event-stream`).",
          parameters: [
            tenantHeader("Mcp-Session-Id", "Required on every request after `initialize`."),
            tenantHeader(
              "X-Affine-Url",
              "`initialize` only. AFFiNE base URL, HTTPS. Its host must be in the server allowlist.",
              { format: "uri", example: "https://affine.example.com" },
            ),
            tenantHeader("X-Affine-Email", "`initialize` only. Use with `X-Affine-Password` or `X-Affine-Password-B64`."),
            tenantHeader("X-Affine-Password", "`initialize` only. Plain password; Latin-1 safe characters only."),
            tenantHeader("X-Affine-Password-B64", "`initialize` only. UTF-8 password, base64-encoded."),
            tenantHeader("X-Affine-Cookie", "`initialize` only. Signed-in AFFiNE `Cookie` header (alternative to email/password)."),
            tenantHeader("X-Affine-Token", "`initialize` only. Bearer token accepted by that AFFiNE server (alternative)."),
            tenantHeader("X-Affine-Workspace-Id", "`initialize` only. Optional default workspace id."),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/JsonRpcRequest" },
                examples: {
                  initialize: {
                    summary: "Open a session",
                    value: {
                      jsonrpc: "2.0",
                      id: 1,
                      method: "initialize",
                      params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "my-app", version: "1.0.0" },
                      },
                    },
                  },
                  listTools: { summary: "List tools", value: { jsonrpc: "2.0", id: 2, method: "tools/list" } },
                  callTool: {
                    summary: "Call a tool",
                    value: {
                      jsonrpc: "2.0",
                      id: 3,
                      method: "tools/call",
                      params: {
                        name: "create_doc_from_markdown",
                        arguments: { workspaceId: "<workspace-id>", title: "Notes", markdown: "# Hello" },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "JSON-RPC response. `initialize` also returns the `Mcp-Session-Id` response header.",
              headers: { "Mcp-Session-Id": { schema: { type: "string" }, description: "Present on `initialize`." } },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/JsonRpcResponse" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            ...rpcErrorResponses,
            "404": { description: "Unknown or expired `Mcp-Session-Id`; open a new session." },
            "503": { description: "Session capacity reached (`AFFINE_MCP_HTTP_MAX_SESSIONS`)." },
          },
        },
        delete: {
          tags: ["Gateway"],
          operationId: "mcpCloseSession",
          summary: "Close a session",
          description: "Releases the session and the credentials held in memory for it.",
          parameters: [{ name: "Mcp-Session-Id", in: "header", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Session closed." }, "404": { description: "Unknown session." } },
        },
      },
      "/healthz": {
        get: {
          tags: ["Gateway"],
          operationId: "healthz",
          summary: "Liveness",
          security: [],
          responses: { "200": { description: "Server is up." } },
        },
      },
      "/readyz": {
        get: {
          tags: ["Gateway"],
          operationId: "readyz",
          summary: "Readiness",
          description: "In multi-tenant mode there is no single upstream, so this reports `upstream: per-tenant`.",
          security: [],
          responses: { "200": { description: "Ready." } },
        },
      },
    },
    webhooks: {},
    components: {
      securitySchemes: {
        gatewayToken: {
          type: "http",
          scheme: "bearer",
          description:
            "`AFFINE_MCP_HTTP_TOKEN`. Identifies your application to the gateway; keep it server-side. It is never forwarded to AFFiNE.",
        },
      },
      schemas: {
        JsonRpcRequest: {
          type: "object",
          required: ["jsonrpc", "method"],
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer"], description: "Omit for notifications." },
            method: { type: "string", examples: ["initialize", "tools/list", "tools/call"] },
            params: { type: "object" },
          },
        },
        JsonRpcResponse: {
          type: "object",
          required: ["jsonrpc"],
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer", "null"] },
            result: { type: "object" },
            error: {
              type: "object",
              properties: { code: { type: "integer" }, message: { type: "string" } },
            },
          },
        },
      },
    },
  };

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = groups.get(tool.name) ?? "docs";
    const annotations = tool.annotations ?? {};
    const hints = [
      annotations.readOnlyHint ? "read-only" : "writes data",
      annotations.destructiveHint ? "destructive" : null,
      annotations.idempotentHint ? "idempotent" : null,
    ].filter(Boolean);
    const operation = {
      tags: [GROUP_TITLES[group] ?? "Documents"],
      operationId: `tool_${tool.name}`,
      summary: tool.title ?? tool.name,
      description: `${tool.description ?? ""}\n\n_Hints: ${hints.join(", ")}._\n\nInvoke with \`tools/call\` on \`POST /mcp\`.`,
      "x-mcp-tool": tool.name,
      "x-mcp-annotations": annotations,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["jsonrpc", "method", "params"],
              properties: {
                jsonrpc: { const: "2.0" },
                id: { type: ["string", "integer"] },
                method: { const: "tools/call" },
                params: {
                  type: "object",
                  required: ["name", "arguments"],
                  properties: {
                    name: { const: tool.name },
                    arguments: cleanSchema(
                      tool.inputSchema ?? { type: "object" },
                      `#/webhooks/tool_${tool.name}/post/requestBody/${JSON_CONTENT}/properties/params/properties/arguments`,
                    ),
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "JSON-RPC result. Tool failures return `isError: true` with a message in `content`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  result: {
                    type: "object",
                    properties: {
                      content: { type: "array", items: { type: "object" } },
                      isError: { type: "boolean" },
                      ...(tool.outputSchema ? { structuredContent: cleanSchema(
                        tool.outputSchema,
                        `#/webhooks/tool_${tool.name}/post/responses/200/${JSON_CONTENT}/properties/result/properties/structuredContent`,
                      ) } : {}),
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    spec.webhooks[`tool_${tool.name}`] = { post: operation };
  }
  return spec;
}

const tools = await listTools();
if (tools.length < 50) throw new Error(`Only ${tools.length} tools listed; refusing to write docs.`);
const spec = buildSpec(tools, loadToolGroups());
writeFileSync(OUT, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUT)} with ${tools.length} tools.`);
