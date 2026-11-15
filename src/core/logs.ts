import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Enough for thousands of lines; a log that has grown for months is not read whole. */
const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The last `count` lines of a log file, keeping only those that mention one of `terms` when any
 * are given. Undefined when the file does not exist.
 */
export function tailLog(file: string, count: number, terms: readonly string[] = []): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let lines = buffer.toString("utf8").split(/\r?\n/);
    // The first line read from the middle of the file is a fragment.
    if (start > 0) lines = lines.slice(1);
    lines = lines.filter((line) => line.trim() !== "");
    const wanted = terms.filter((t) => t.trim() !== "");
    if (wanted.length) lines = lines.filter((line) => wanted.some((t) => mentions(line, t)));
    return count > 0 ? lines.slice(-count) : [];
  } finally {
    closeSync(fd);
  }
}

/** `term` as a whole word, so the agent "Al" does not match every line saying "already". */
function mentions(line: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "u").test(line);
}
