import { createHash } from "node:crypto";
import type { CommandResult } from "../platform/command.ts";
import { MingleError } from "./errors.ts";

/**
 * Reminders that fire on change (docs/spec.md 4.6): Mingle runs a shell command on the reminder's
 * rule and wakes the agent only when its output changes. Pure, apart from hashing.
 */

export const CHECK_TIMEOUT_MS = 60_000;
export const CHECK_MAX_OUTPUT = 1024 * 1024;
/** Kept for the agent and the console; the comparison uses the hash of all of it. */
export const CHECK_OUTPUT_KEPT = 4000;
/** Failed runs in a row before the agent hears about it, once. */
export const CHECK_FAILURES_TOLD = 3;
export const CHECK_MIN_INTERVAL_MS = 60_000;
const SHOWN = 1500;
const STDERR_LINES = 5;
const MAX_COMMAND = 4000;

export type CheckOutcome =
  | { readonly ok: true; readonly hash: string; readonly output: string }
  | { readonly ok: false; readonly error: string };

export function checkCommand(command: unknown): string {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) throw new MingleError("check_required", "give --check a shell command, like --check 'gh pr checks 12'");
  if (text.length > MAX_COMMAND)
    throw new MingleError("check_too_long", "keep the command under 4000 characters; put a longer one in a script");
  return text;
}

/** What a run says: the output to compare, or why it failed. */
export function outcome(result: CommandResult): CheckOutcome {
  if (result.killed === "timeout") return { ok: false, error: `timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
  if (result.killed === "output_too_large") return { ok: false, error: "printed more than 1 MiB" };
  if (result.killed) return { ok: false, error: `could not run: ${result.killed}` };
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-STDERR_LINES).join("\n").trim();
    return { ok: false, error: `exited with ${result.code}${tail ? `: ${tail}` : ""}` };
  }
  const output = result.stdout.trim();
  return {
    ok: true,
    hash: createHash("sha256").update(output).digest("hex"),
    output: output.slice(0, CHECK_OUTPUT_KEPT),
  };
}

function shown(output: string | null): string {
  if (!output) return "(empty)";
  return output.length > SHOWN ? `${output.slice(0, SHOWN)}…` : output;
}

/** What follows the reminder's text when its output changed. */
export function changedText(before: string | null, now: string): string {
  return `Check output before:\n${shown(before)}\nCheck output now:\n${shown(now)}`;
}

/** What follows the reminder's text when the command keeps failing. */
export function failingText(command: string, failures: number, error: string, id: string): string {
  return [
    `The check has failed ${failures} times in a row; it keeps running, and you won't hear about it again until it works once.`,
    `Command: ${command}`,
    `Last error: ${error}`,
    `To fix the command, cancel ${id} and set it again; if it is no longer needed, cancel it.`,
  ].join("\n");
}
