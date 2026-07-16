import { type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h)
  );
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return Response.json({ error: "thiếu tham số url" }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return Response.json({ error: "url không hợp lệ" }, { status: 400 });
  }
  if (!/^https?:$/.test(target.protocol) || isBlockedHost(target.hostname)) {
    return Response.json({ error: "url không được phép" }, { status: 400 });
  }

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  const range = req.headers.get("range");
  if (range) headers["Range"] = range;
  if (/tiktok/i.test(target.hostname)) {
    headers["Referer"] = "https://www.tiktok.com/";
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers });
  } catch {
    return Response.json(
      { error: "không tải được media từ url" },
      { status: 502 },
    );
  }
  if (!upstream.ok && upstream.status !== 206) {
    return Response.json(
      { error: `nguồn trả về ${upstream.status}` },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstream.headers.get(key);
    if (value) out.set(key, value);
  }
  out.set("Cache-Control", "no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
}
