/**
 * Nosana Inference Proxy
 * Forwards all requests to the upstream Nosana endpoint,
 * injecting chat_template_kwargs: { enable_thinking: false }
 * into every /v1/chat/completions request so Qwen3.5 returns
 * plain content instead of null+reasoning fields.
 *
 * Usage: bun run inference-proxy.ts
 * Then set OPENAI_BASE_URL=http://localhost:3001/v1 in .env
 */

const UPSTREAM = process.env.NOSANA_INFERENCE_URL ?? "https://5i8frj7ann99bbw9gzpprvzj2esugg39hxbb4unypskq.node.k8s.prd.nos.ci";
const PORT = 3001;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;

    const headers = new Headers(req.headers);
    headers.delete("host");

    let body = req.body;

    if (
      req.method === "POST" &&
      url.pathname === "/v1/chat/completions" &&
      req.headers.get("content-type")?.includes("application/json")
    ) {
      const json = await req.json();
      json.chat_template_kwargs = { enable_thinking: false };
      body = JSON.stringify(json);
      headers.set("content-length", String(Buffer.byteLength(body)));
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },
});

console.log(`[inference-proxy] Listening on http://localhost:${PORT}`);
console.log(`[inference-proxy] Upstream: ${UPSTREAM}`);
