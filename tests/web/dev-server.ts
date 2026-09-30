/**
 * A real production Next.js server for the web tests (Phase 5a).
 *
 * Production (`next build` + `next start`), not `next dev` — a deliberate
 * choice with two justifications, one empirical:
 *
 *   1. **Empirical:** under Playwright's Chromium on this machine, Next 16
 *      dev-mode's HMR websocket handshake fails (`ERR_INVALID_HTTP_RESPONSE`
 *      — curl completes the same handshake, so it is not the server), and
 *      the dev bootstrap then stalls *silently* before React hydrates: the
 *      page renders server-side but no client code ever runs. Production
 *      mode has no HMR socket at all and hydrates cleanly (verified: fiber
 *      nodes present, zero console errors, interactive).
 *   2. **Realism:** this is also what a judge actually runs — `npm run
 *      build && npm run start` — so the smoke test's "zero console errors"
 *      claim is about the real artifact, not a dev build with its overlay
 *      and refresh machinery.
 *
 * The build runs **once per mocha process** (shared across the three web
 * suites) and fails loudly with the build log if the source does not build.
 * The child inherits `process.env`, which `load-env.ts` has already pinned to
 * `tests/.env.test`, so the server under test runs on the same TST
 * configuration as everything else in the suite.
 *
 * Every server picks its own free port and is torn down by killing its
 * process *tree* — Next spawns workers, and leaving them behind would leak a
 * port per suite run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const appDir = resolve(process.cwd(), "app");
const nextBin = resolve(appDir, "node_modules", "next", "dist", "bin", "next");

export interface DevServer {
  origin: string;
  close: () => Promise<void>;
}

/** Asks the OS for a free TCP port, then releases it for the server to bind. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** `next build`, run at most once per mocha process; shared by every suite. */
let buildOnce: Promise<void> | null = null;
function ensureBuilt(): Promise<void> {
  if (buildOnce === null) {
    buildOnce = new Promise<void>((resolveBuild, rejectBuild) => {
      const child: ChildProcess = spawn(process.execPath, [nextBin, "build"], {
        cwd: appDir,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", rejectBuild);
      child.on("exit", (code) => {
        if (code === 0) resolveBuild();
        else rejectBuild(new Error(`next build exited with ${code}\n${output.slice(-4000)}`));
      });
    });
    // A failed build must not poison every later suite: clear so the next
    // caller sees the failure again (and can retry after a fix).
    buildOnce.catch(() => {
      buildOnce = null;
    });
  }
  return buildOnce;
}

export async function startDevServer(label: string): Promise<DevServer> {
  await ensureBuilt();

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "--port", String(port)],
    {
      cwd: appDir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${label}: next start exited with ${child.exitCode}\n${output}`);
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status === 200 || response.status === 307 || response.status === 308) break;
    } catch {
      // Not listening yet — keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: next start never came up on ${origin}\n${output}`);
    }
    await new Promise((wait) => setTimeout(wait, 500));
  }

  return {
    origin,
    close: () =>
      new Promise<void>((resolveClose) => {
        const pid = child.pid;
        if (pid === undefined) {
          resolveClose();
          return;
        }
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
          });
          killer.on("exit", () => resolveClose());
          killer.on("error", () => {
            child.kill();
            resolveClose();
          });
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          resolveClose();
        }
      }),
  };
}
