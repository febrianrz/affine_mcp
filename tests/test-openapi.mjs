#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const spec = JSON.parse(read("docs/openapi.json"));
const manifest = JSON.parse(read("tool-manifest.json"));
const manifestTools = (Array.isArray(manifest) ? manifest : manifest.tools).map((t) => (typeof t === "string" ? t : t.name));
const pkg = JSON.parse(read("package.json"));

assert.match(spec.openapi, /^3\.1/);
assert.equal(spec.info.version, pkg.version, "openapi version must match package.json; run npm run docs:openapi");

for (const route of ["/mcp", "/healthz", "/readyz"]) assert.ok(spec.paths[route], `missing path ${route}`);

// Every documented tool is a real tool, and only the multi-tenant exclusions are missing.
const documented = Object.values(spec.webhooks).map((w) => w.post["x-mcp-tool"]);
assert.equal(new Set(documented).size, documented.length, "duplicate tool docs");
for (const name of documented) assert.ok(manifestTools.includes(name), `unknown tool in openapi: ${name}`);
const missing = manifestTools.filter((name) => !documented.includes(name));
assert.deepEqual(missing, ["sign_in"], `tools missing from openapi (run npm run docs:openapi): ${missing.join(", ")}`);

// All internal $refs resolve.
const resolve = (pointer) =>
  pointer.slice(2).split("/").reduce((node, part) => node[part.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
let refs = 0;
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") {
      refs += 1;
      assert.notEqual(resolve(value), undefined, `broken $ref ${value}`);
    } else walk(value);
  }
})(spec);
assert.ok(refs > 0);

// The Scalar page pins an exact version and points at the spec.
const html = read("docs/index.html");
assert.match(html, /@scalar\/api-reference@\d+\.\d+\.\d+"/, "Scalar version must be pinned");
assert.match(html, /data-url="\.\/openapi\.json"/);

console.log("OpenAPI docs tests passed");
