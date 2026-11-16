// Package portable source/build assets; dependencies are installed for the remote host's platform.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "mingle-remote-package-"));
try {
  cpSync("dist", join(stage, "dist"), { recursive: true, filter: (path) => !path.endsWith("ssh-runtime.tgz") });
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSE"])
    cpSync(file, join(stage, file));
  execFileSync(
    "tar",
    [
      "-czf",
      resolve("dist/ssh-runtime.tgz"),
      "-C",
      stage,
      "dist",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "LICENSE",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
