import { randomInt } from "node:crypto";
import type { ChatKind, Trust } from "../channels/channel.ts";
import type { Access } from "../store/store.ts";

/**
 * Who can put an agent to work (docs/spec.md 4.7). Anyone who can message the agent can run
 * commands on the owner's computer through it, so a person or group the owner has not let in
 * does not reach the agent where the bot is open to the public.
 *
 *   deliver: hand the message to the agent, as always.
 *   ask:     keep it (`held`) until the owner allows or refuses its sender or group.
 *   drop:    keep it on record only; it never wakes the agent (someone the owner refused).
 */
export type Verdict = "deliver" | "ask" | "drop";

export interface GateInput {
  /** What the bot's chat app declares about who can reach it. */
  readonly trust: Trust;
  /** The owner asked to be asked about new people and groups on every chat app. */
  readonly askAll: boolean;
  readonly isOwner: boolean;
  readonly chatKind: ChatKind;
  readonly contact: Access;
  /** For a group or thread: the group's access (a thread's is its group's). */
  readonly group: Access;
}

export function gate(input: GateInput): Verdict {
  if (input.isOwner) return "deliver";
  // Someone the owner refused stays refused everywhere, groups included.
  if (input.contact === "blocked") return "drop";
  const decided = input.chatKind === "dm" ? input.contact : input.group;
  if (decided === "allowed") return "deliver";
  if (decided === "blocked") return "drop";
  return input.trust === "public" || input.askAll ? "ask" : "deliver";
}

/** How long a claim code works: long enough to switch to the phone, short enough not to linger. */
export const CLAIM_TTL_MS = 10 * 60_000;
/** Wrong codes a bot takes before its code stops working, so it cannot be guessed. */
export const CLAIM_ATTEMPTS = 5;

/** A fresh six-digit claim code. */
export function claimCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * The code in a message that looks like a claim: `/start 123456`, the way a Telegram deep link
 * sends it, or the six digits alone (Slack keeps `/…` for its own commands). Undefined otherwise.
 */
export function claimAttempt(text: string): string | undefined {
  return /^(?:\/start\s+)?(\d{6})$/i.exec(text.trim())?.[1];
}
