#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

const args = process.argv.slice(2);
const noServer = args.includes("--no-server");
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

if (!noServer) {
  console.log("==> Starting Go backend (port 8080)...");
  const server = run("go", ["run", "."], path.join(root, "server"), "server", "36");
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[server] exited with code ${code}`);
  });

  console.log("==> Starting Python sidecar (port 8500)...");
  const pythonCmd = process.env.PYTHON ?? (isWin ? "py" : "python3");
  const pythonArgs = process.env.PYTHON ? [] : isWin ? ["-3.13"] : [];
  const sidecar = run(
    pythonCmd,
    [...pythonArgs, "main.py"],
    path.join(root, "server", "sidecar"),
    "sidecar",
    "33"
  );
  sidecar.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[sidecar] exited with code ${code}`);
  });
}

const feDir = path.join(root, fe);
const startFe = () => {
  console.log(`==> Starting frontend '${fe}'...`);
  const feProc = run("npm", ["run", "dev"], feDir, fe, "35");
  feProc.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
};

if (!existsSync(path.join(feDir, "node_modules"))) {
  console.log("==> node_modules missing, running npm install...");
  const install = isWin
    ? spawn("npm install", { cwd: feDir, shell: true, stdio: "inherit" })
    : spawn("npm", ["install"], { cwd: feDir, stdio: "inherit" });
  install.on("exit", (code) => {
    if (code !== 0) { shutdown(); process.exit(code); }
    startFe();
  });
} else {
  startFe();
}
