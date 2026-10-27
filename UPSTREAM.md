# Upstream

Imported from https://github.com/DAWNCR0W/affine-mcp-server (MIT) at commit
`4bd2994cd070f8d8d52594502f4020306e411b37` (v3.10.2). Original LICENSE retained.

Audit at import: no install/postinstall scripts, no child_process/eval, no telemetry;
outbound requests go only to the configured AFFiNE endpoint.

## Credits

Original work by DAWNCR0W and the affine-mcp-server contributors (MIT). Additions in this
repository: multi-tenant mode (`src/tenant.ts`), the OpenAPI generator
(`scripts/generate-openapi.mjs`), the Scalar page (`docs/index.html`), and `deploy/multi-account/`.
