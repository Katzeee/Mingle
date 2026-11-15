import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  readonly home: string;
  readonly db: string;
  readonly agents: string;
  /** Agents' pictures, kept beside their homes rather than inside them (docs/spec.md 8.1). */
  readonly avatars: string;
  readonly bin: string;
  readonly logs: string;
  readonly runtime: string;
}

export function resolvePaths(home = process.env.MINGLE_HOME ?? join(homedir(), ".mingle")): Paths {
  return {
    home,
    db: join(home, "mingle.db"),
    agents: join(home, "agents"),
    avatars: join(home, "avatars"),
    bin: join(home, "bin"),
    logs: join(home, "logs"),
    runtime: join(home, "runtime.json"),
  };
}
