import { createHash } from "node:crypto";
import type { CommandResult } from "../platform/command.ts";
import { MingleError } from "./errors.ts";

/**
 * Reminders that fire on change (docs/spec.md 4.6): Mingle runs a shell command on the reminder's
 * rule and wakes the agent only when its output changes. Pure, apart from hashing.
 */

export const CHECK_TIMEOUT_MS = 60_000;
export const CHECK_MAX_OUTPUT = 1024 * 1024;
/** How much of the current output is told to the agent at set-up and on a change; never stored. */
export const CHECK_OUTPUT_KEPT = 4000;
/** Failed runs in a row before the agent hears about it, once. */
export const CHECK_FAILURES_TOLD = 3;
export const CHECK_MIN_INTERVAL_MS = 60_000;
/** How long a check runs when `--for` is not given, and the most it may be given. */
export const CHECK_DEFAULT_FOR_MS = 7 * 86_400_000;
export const CHECK_MAX_FOR_MS = 90 * 86_400_000;
const SHOWN = 1500;
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

/**
 * What a run says: the output to compare, or why it failed. Failures are only ever known strings —
 * a timeout, too much output, a cancellation, a spawn failure or the exit code — never the
 * command's standard error or an exception's message, which can carry whatever the tool printed.
 */
export function outcome(result: CommandResult): CheckOutcome {
  if (result.killed === "timeout") return { ok: false, error: `timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
  if (result.killed === "output_too_large") return { ok: false, error: "printed more than 1 MiB" };
  if (result.killed === "cancelled") return { ok: false, error: "was cancelled" };
  if (result.killed) return { ok: false, error: "could not run" };
  if (result.code !== 0) return { ok: false, error: `exited with ${result.code}` };
  const output = result.stdout.trim();
  return {
    ok: true,
    hash: createHash("sha256").update(output).digest("hex"),
    output: output.slice(0, CHECK_OUTPUT_KEPT),
  };
}

function shown(output: string): string {
  if (!output) return "(empty)";
  return output.length > SHOWN ? `${output.slice(0, SHOWN)}…` : output;
}

/** What follows the reminder's text when its output changed: the current output, nothing stored. */
export function changedText(now: string): string {
  return `Check output now:\n${shown(now)}`;
}

/** What follows the reminder's text when it stopped checking because its time was up. */
export function expiredText(id: string): string {
  return [
    "Stopped checking: its time is up.",
    `If it is still worth waiting for, set it again with a longer --for; otherwise tell whoever asked, if they are still waiting. (${id} is gone.)`,
  ].join("\n");
}

/** What follows the reminder's text when the command keeps failing. */
export function failingText(failures: number, error: string, id: string): string {
  return [
    `The check has failed ${failures} times in a row; it keeps running, and you won't hear about it again until it works once.`,
    `Last error: ${error}`,
    `To fix the command, cancel ${id} and set it again; if it is no longer needed, cancel it.`,
  ].join("\n");
}
