import { readFile } from "node:fs/promises";
import type express from "express";
import type { Request, Response } from "express";

import type { ServerConfig } from "./config.js";
import { parseBooleanFlag } from "./networkSecurity.js";

const DOCS_DIR = new URL("../docs/", import.meta.url);

type DocAsset = { body: string; contentType: string };

/**
 * Serve the Scalar API reference at `/docs` and the OpenAPI spec at `/openapi.json`.
 * Both describe the tool surface and contain no secrets, so they are public.
 * Set `AFFINE_MCP_DOCS=false` to turn them off.
 */
export function registerHttpDocsRoutes(app: express.Express, config: ServerConfig): void {
  const raw = process.env.AFFINE_MCP_DOCS;
  const enabled = raw === undefined || raw.trim() === "" ? true : parseBooleanFlag("AFFINE_MCP_DOCS", raw);
  if (!enabled) return;

  const cache = new Map<string, DocAsset>();
  const load = async (file: "index.html" | "openapi.json"): Promise<DocAsset | undefined> => {
    const cached = cache.get(file);
    if (cached) return cached;
    let text: string;
    try {
      text = await readFile(new URL(file, DOCS_DIR), "utf8");
    } catch {
      return undefined;
    }
    let asset: DocAsset;
    if (file === "openapi.json") {
      const spec = JSON.parse(text);
      // Point "Try it" and snippets at this deployment when its public URL is configured.
      if (config.publicBaseUrl && spec.servers?.[0]?.variables?.baseUrl) {
        spec.servers[0].variables.baseUrl.default = config.publicBaseUrl;
      }
      asset = { body: JSON.stringify(spec), contentType: "application/json; charset=utf-8" };
    } else {
      asset = { body: text, contentType: "text/html; charset=utf-8" };
    }
    cache.set(file, asset);
    return asset;
  };

  app.get(["/docs", "/openapi.json", "/docs/openapi.json"], async (req: Request, res: Response) => {
    const asset = await load(req.path.endsWith("openapi.json") ? "openapi.json" : "index.html");
    if (!asset) {
      res.status(404).send("API documentation is not available in this build.");
      return;
    }
    res
      .set({
        "Content-Type": asset.contentType,
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      })
      .send(asset.body);
  });
}
