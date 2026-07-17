import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// Proxy same-origin sang Go gateway (/api/data/*) để trình duyệt không phải
// gọi cross-origin — tránh lỗi CORS/"Failed to fetch" khi gateway đổi port
// (port 8080 hay bị Apache/XAMPP chiếm) hoặc khi truy cập qua domain.

let cachedBase: string | null = null;

async function isGateway(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1000),
      cache: "no-store",
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function findGateway(): Promise<string | null> {
  if (cachedBase && (await isGateway(cachedBase))) return cachedBase;
  cachedBase = null;
  const candidates = [
    process.env.API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    ...Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${8080 + i}`),
  ].filter((v): v is string => Boolean(v));
  for (const base of candidates) {
    if (await isGateway(base)) {
      cachedBase = base;
      return base;
    }
  }
  return null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params;
  const base = await findGateway();
  if (!base) {
    return Response.json(
      {
        error:
          "Backend Go chưa chạy — khởi động lại bằng `node dev.mjs` (hoặc `go run .` trong tiktok/server)",
      },
      { status: 502 },
    );
  }
  const target = `${base}/api/data/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { cache: "no-store" });
  } catch {
    cachedBase = null;
    return Response.json({ error: "không gọi được backend Go" }, { status: 502 });
  }
  const out = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) out.set("content-type", contentType);
  out.set("Cache-Control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
