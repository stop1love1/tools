import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev server được truy cập qua reverse proxy — cho phép các origin này
  // request tài nguyên dev (_next/webpack-hmr…) thay vì chỉ localhost
  allowedDevOrigins: ["dance-with-music.stop1love1.online", "*.stop1love1.online"],
};

export default nextConfig;
