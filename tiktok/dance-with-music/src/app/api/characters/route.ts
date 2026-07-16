import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dir = join(process.cwd(), "public", "characters");
    const files = await readdir(dir);
    const urls = files
      .filter((f) => /\.(png|webp)$/i.test(f))
      .sort()
      .map((f) => `/characters/${f}`);
    return NextResponse.json({ urls });
  } catch {
    return NextResponse.json({ urls: [] });
  }
}
