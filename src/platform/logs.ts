import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the desktop app writes Mingle's error output (docs/spec.md 9.1): Node's own messages and
 * crash traces, which never reach `~/.mingle/logs/mingle.log`. mygo's `PathLogs` for an app named
 * "Mingle": `~/Library/Logs/Mingle` on macOS, else `logs` in Go's `os.UserConfigDir()/Mingle`.
 */
export function desktopLogFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === "darwin") return join(home, "Library", "Logs", "Mingle", "mingle.log");
  const config =
    platform === "win32"
      ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
      : env.XDG_CONFIG_HOME?.startsWith("/")
        ? env.XDG_CONFIG_HOME
        : join(home, ".config");
  return join(config, "Mingle", "logs", "mingle.log");
}
