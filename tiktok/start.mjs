#!/usr/bin/env node
// Production launcher: build Go backend + frontend rồi chạy tất cả.
// Dùng cho chạy thật; khi dev dùng dev.mjs (hot-reload, không build).
//
//   node start.mjs                     # hỏi chọn FE, build + chạy
//   node start.mjs dance-with-music    # chỉ định FE
//   node start.mjs --no-server         # chỉ build + chạy FE
//   node start.mjs --skip-build        # chạy lại bản build sẵn có
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

// Port đã có service chạy (vd sidecar mở sẵn ở terminal khác) → bỏ qua,
// không spawn chồng để rồi crash vì bind trùng địa chỉ
const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });

// Port bận chưa chắc là backend của mình (Apache/XAMPP hay chiếm 8080) —
// phải hỏi /api/health để chắc chắn trước khi bỏ qua việc spawn
const isOurBackend = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
};

const findFreePort = async (from, to) => {
  for (let p = from; p <= to; p++) if (await portFree(p)) return p;
  return null;
};

const root = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

const args = process.argv.slice(2);
const noServer = args.includes("--no-server");
const skipBuild = args.includes("--skip-build");
let fe = args.find((a) => !a.startsWith("-"));

const feApps = readdirSync(root, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      d.name !== "server" &&
      existsSync(path.join(root, d.name, "package.json"))
  )
  .map((d) => d.name);

if (feApps.length === 0) {
  console.error(`No frontend found (folder with package.json) in ${root}`);
  process.exit(1);
}

if (!fe) {
  console.log("\nPick a frontend to start:");
  feApps.forEach((name, i) => console.log(`  [${i + 1}] ${name}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Number (Enter = 1): ")).trim();
  rl.close();
  fe = feApps[(parseInt(answer, 10) || 1) - 1];
}

if (!feApps.includes(fe)) {
  console.error(`No frontend named '${fe}'. Available: ${feApps.join(", ")}`);
  process.exit(1);
}

function sh(cmd, cmdArgs, cwd, label, env) {
  console.log(`==> ${label}`);
  const opts = {
    cwd,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  };
  const r = isWin
    ? spawnSync([cmd, ...cmdArgs].join(" "), { ...opts, shell: true })
    : spawnSync(cmd, cmdArgs, opts);
  if (r.status !== 0) {
    console.error(`'${label}' failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const children = [];
function run(cmd, cmdArgs, cwd, prefix, color, env) {
  const opts = { cwd, env: env ? { ...process.env, ...env } : process.env };
  const child = isWin
    ? spawn([cmd, ...cmdArgs].join(" "), { ...opts, shell: true })
    : spawn(cmd, cmdArgs, opts);
  const tag = `\x1b[${color}m[${prefix}]\x1b[0m`;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) if (!c.killed) c.kill();
}
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

const feDir = path.join(root, fe);
const serverDir = path.join(root, "server");
const serverBin = path.join(
  serverDir,
  "bin",
  isWin ? "tiktok-server.exe" : "tiktok-server"
);

// --- Port backend --------------------------------------------------------
// Phải chốt port TRƯỚC khi build vì NEXT_PUBLIC_* được nướng vào bundle lúc build
let apiPort = 8080;
let startBackend = !noServer;
if (!noServer && !(await portFree(8080))) {
  if (await isOurBackend(8080)) {
    console.log("==> Port 8080: backend đã chạy sẵn, bỏ qua.");
    startBackend = false;
  } else {
    // Backend có thể đã chạy sẵn ở port dự phòng từ lần trước
    let existing = null;
    for (let p = 8081; p <= 8099 && existing === null; p++) {
      if (!(await portFree(p)) && (await isOurBackend(p))) existing = p;
    }
    if (existing !== null) {
      apiPort = existing;
      startBackend = false;
      console.log(`==> Backend đã chạy sẵn ở port ${existing}, bỏ qua.`);
    } else {
      apiPort = await findFreePort(8081, 8099);
      if (apiPort === null) {
        console.error("==> Không tìm được port trống 8081–8099 cho backend.");
        process.exit(1);
      }
      console.warn(
        `==> Port 8080 bị process khác chiếm (không phải backend của tools) — chuyển backend sang port ${apiPort}.`
      );
    }
  }
}

const feEnv = {
  NEXT_PUBLIC_API_URL:
    process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${apiPort}`,
  NEXT_PUBLIC_LIVE_WS_URL:
    process.env.NEXT_PUBLIC_LIVE_WS_URL ?? `ws://localhost:${apiPort}/ws`,
};

// --- Build ---------------------------------------------------------------
if (!existsSync(path.join(feDir, "node_modules"))) {
  sh("npm", ["install"], feDir, `npm install (${fe})`);
}
if (!skipBuild) {
  if (!noServer) {
    mkdirSync(path.dirname(serverBin), { recursive: true });
    sh("go", ["build", "-o", serverBin, "."], serverDir, "go build (server)");
  }
  sh("npm", ["run", "build"], feDir, `npm run build (${fe})`, feEnv);
} else if (!noServer && !existsSync(serverBin)) {
  console.error(`--skip-build nhưng chưa có ${serverBin} — chạy không kèm --skip-build trước.`);
  process.exit(1);
}

// --- Run -----------------------------------------------------------------
if (startBackend) {
  console.log(`==> Starting Go backend (port ${apiPort})...`);
  const server = run(serverBin, [], serverDir, "server", "36", {
    PORT: String(apiPort),
  });
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[server] exited with code ${code}`);
  });
}
if (!noServer) {

  if (await portFree(8500)) {
    console.log("==> Starting Python sidecar (port 8500)...");
    const pythonCmd = process.env.PYTHON ?? (isWin ? "py" : "python3");
    const pythonArgs = process.env.PYTHON ? [] : isWin ? ["-3.13"] : [];
    const sidecar = run(
      pythonCmd,
      [...pythonArgs, "main.py"],
      path.join(serverDir, "sidecar"),
      "sidecar",
      "33"
    );
    sidecar.on("exit", (code) => {
      if (code !== 0 && code !== null) console.error(`[sidecar] exited with code ${code}`);
    });
  } else {
    console.log("==> Port 8500 đang bận — sidecar đã chạy sẵn, bỏ qua.");
  }
}

console.log(`==> Starting frontend '${fe}' (production)...`);
const feProc = run("npm", ["run", "start"], feDir, fe, "35", feEnv);
feProc.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
