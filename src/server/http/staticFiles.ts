import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson, setCommonSecurityHeaders } from "./response.js";

export async function serveStatic(appRoot: string, pathname: string, response: ServerResponse, options: { head?: boolean } = {}): Promise<void> {
  const distRoot = resolve(appRoot, "dist");
  const decodedPath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const requested = resolve(distRoot, `.${normalize(decodedPath)}`);
  const relativePath = relative(distRoot, requested);
  if (relativePath.startsWith("..") || (relativePath === "" && requested !== distRoot)) {
    sendJson(response, 403, { ok: false, error: "Forbidden path." });
    return;
  }

  const requestedStats = await statIfPresent(requested);
  const filePath = requestedStats?.isFile() ? requested : join(distRoot, "index.html");
  const fileStats = await statIfPresent(filePath);
  if (!fileStats?.isFile()) {
    sendJson(response, 404, {
      ok: false,
      error: "Frontend build was not found. Run `npm run build` or use `npm run dev` for development."
    });
    return;
  }

  setCommonSecurityHeaders(response);
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"
  );
  response.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": String(fileStats.size),
    "Cache-Control": cacheControl(filePath)
  });
  if (options.head) {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function cacheControl(filePath: string): string {
  if (filePath.endsWith("index.html")) return "no-cache";
  return /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache";
}

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
