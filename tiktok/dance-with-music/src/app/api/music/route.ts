import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dir = join(process.cwd(), "public", "music");
    const files = await readdir(dir);
    const tracks = files
      .filter((f) => /\.(mp3|ogg|m4a|wav)$/i.test(f))
      .sort()
      .map((f) => ({
        url: `/music/${encodeURIComponent(f)}`,
        title: f.replace(/\.(mp3|ogg|m4a|wav)$/i, ""),
      }));
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ tracks: [] });
  }
}
