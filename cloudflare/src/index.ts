import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

const CLOUDFLARE_HEADERS_TO_STRIP = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;

function getBuildSha(env: Env): string {
  return String(env.BUILD_SHA ?? "").trim() || "dev";
}

function getUpstreamBaseUrl(env: Env): URL {
  const raw = String(env.UPSTREAM_BASE_URL ?? "").trim();
  if (!raw) {
    throw new Error("Missing UPSTREAM_BASE_URL. Configure it in wrangler.toml or CI secrets.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid UPSTREAM_BASE_URL: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported UPSTREAM_BASE_URL protocol: ${url.protocol}`);
  }
  return url;
}

function joinPath(basePath: string, requestPath: string): string {
  const cleanBase = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const cleanRequest = requestPath.replace(/^\/+/, "");
  return cleanBase ? `${cleanBase}/${cleanRequest}` : `/${cleanRequest}`;
}

function buildUpstreamUrl(requestUrl: string, env: Env): URL {
  const incoming = new URL(requestUrl);
  const upstream = getUpstreamBaseUrl(env);
  upstream.pathname = joinPath(upstream.pathname, incoming.pathname);
  upstream.search = incoming.search;
  upstream.hash = incoming.hash;
  return upstream;
}

function buildProxyHeaders(request: Request, upstreamUrl: URL): Headers {
  const headers = new Headers(request.headers);

  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  for (const header of CLOUDFLARE_HEADERS_TO_STRIP) headers.delete(header);

  headers.delete("host");

  const incoming = new URL(request.url);
  const forwardedFor =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-worker", "cloudflare");
  headers.set("x-proxied-by", "grok2api-cloudflare-worker");
  headers.set("origin", upstreamUrl.origin);

  return headers;
}

function rewriteLocationHeader(location: string, requestUrl: string, upstreamBase: URL): string {
  try {
    const incoming = new URL(requestUrl);
    const absolute = new URL(location, upstreamBase);
    if (absolute.origin !== upstreamBase.origin) return location;

    const rewritten = new URL(incoming.origin);
    rewritten.pathname = absolute.pathname;
    rewritten.search = absolute.search;
    rewritten.hash = absolute.hash;
    return rewritten.toString();
  } catch {
    return location;
  }
}

function withProxyHeaders(response: Response, requestUrl: string, env: Env): Response {
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) {
    headers.set("location", rewriteLocationHeader(location, requestUrl, getUpstreamBaseUrl(env)));
  }
  headers.set("x-grok2api-runtime", "cloudflare-worker-proxy");
  headers.set("x-grok2api-build", getBuildSha(env));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyRequest(request: Request, env: Env): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(request.url, env);
  const headers = buildProxyHeaders(request, upstreamUrl);
  const method = request.method.toUpperCase();

  const init: RequestInit = {
    method,
    headers,
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;

  const upstreamRequest = new Request(upstreamUrl.toString(), init);

  const response = await fetch(upstreamRequest);
  return withProxyHeaders(response, request.url, env);
}

app.get("/_worker/health", (c) =>
  c.json({
    status: "ok",
    runtime: "cloudflare-worker-proxy",
    build: { sha: getBuildSha(c.env) },
    upstream: getUpstreamBaseUrl(c.env).origin,
  }),
);

app.onError((err, c) => {
  console.error("Worker proxy error:", err);
  return c.json(
    {
      status: "error",
      runtime: "cloudflare-worker-proxy",
      message: err instanceof Error ? err.message : String(err),
      build: { sha: getBuildSha(c.env) },
    },
    502,
  );
});

app.all("*", async (c) => proxyRequest(c.req.raw, c.env));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
