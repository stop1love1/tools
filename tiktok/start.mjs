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
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

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

function sh(cmd, cmdArgs, cwd, label) {
  console.log(`==> ${label}`);
  const r = isWin
    ? spawnSync([cmd, ...cmdArgs].join(" "), { cwd, shell: true, stdio: "inherit" })
    : spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`'${label}' failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const children = [];
function run(cmd, cmdArgs, cwd, prefix, color) {
  const child = isWin
    ? spawn([cmd, ...cmdArgs].join(" "), { cwd, shell: true })
    : spawn(cmd, cmdArgs, { cwd });
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

// --- Build ---------------------------------------------------------------
if (!existsSync(path.join(feDir, "node_modules"))) {
  sh("npm", ["install"], feDir, `npm install (${fe})`);
}
if (!skipBuild) {
  if (!noServer) {
    mkdirSync(path.dirname(serverBin), { recursive: true });
    sh("go", ["build", "-o", serverBin, "."], serverDir, "go build (server)");
  }
  sh("npm", ["run", "build"], feDir, `npm run build (${fe})`);
} else if (!noServer && !existsSync(serverBin)) {
  console.error(`--skip-build nhưng chưa có ${serverBin} — chạy không kèm --skip-build trước.`);
  process.exit(1);
}

// --- Run -----------------------------------------------------------------
if (!noServer) {
  console.log("==> Starting Go backend (port 8080)...");
  const server = run(serverBin, [], serverDir, "server", "36");
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[server] exited with code ${code}`);
  });

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
}

console.log(`==> Starting frontend '${fe}' (production)...`);
const feProc = run("npm", ["run", "start"], feDir, fe, "35");
feProc.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
