import { spawn } from "node:child_process";

export interface CommandResult {
  /** Exit code, or null when it was killed (timeout, too much output) or could not start. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it did not finish on its own: "timeout", "output_too_large" or a spawn error. */
  readonly killed?: string;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * Runs one shell command (/bin/sh on POSIX, cmd.exe on Windows) and collects its output. On a
 * timeout or too much output the whole process group is killed, so a `curl` behind a pipe does not
 * outlive it. Never rejects.
 */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const posix = process.platform !== "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a kill reaches everything the shell started.
        detached: posix,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", killed: (error as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed: string | undefined;
    let done = false;
    const kill = (reason: string) => {
      if (killed || done) return;
      killed = reason;
      try {
        if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > options.maxOutputBytes) kill("output_too_large");
      else out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Only the tail is ever shown; keep a bounded amount.
      if (errBytes < 64 * 1024) {
        err.push(chunk);
        errBytes += chunk.length;
      }
    });
    const finish = (code: number | null, spawnError?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const reason = killed ?? spawnError;
      resolve({
        code: reason ? null : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...(reason ? { killed: reason } : {}),
      });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}
