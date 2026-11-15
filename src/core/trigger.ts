/**
 * Which inbound messages wake the agent (docs/spec.md 4.2), and the brake on bots waking each
 * other. Pure, so the rules can be read and tested in one place.
 *
 * - A person: every direct message; in a group, an @-mention or a reply to the agent.
 * - Another bot: never wakes it by a reply or in a direct message, only by @-mentioning it in the
 *   text. Replies between bots happen by themselves; writing someone's name is a deliberate handoff.
 * - The brake: in each chat, count the turns bots started since a person last spoke there. After
 *   `MAX_BOT_HOPS` of them, bots stop waking the agent in that chat until a person speaks again.
 */

/** Turns in a row that bots may start in one chat before Mingle stops the exchange. */
export const MAX_BOT_HOPS = 5;

export interface TriggerInput {
  readonly dm: boolean;
  /** The sender is a bot: the platform says so, it is one of this computer's agents, or the owner marked it. */
  readonly bot: boolean;
  /** @-mentioned in the text itself. */
  readonly mentioned: boolean;
  /** @-mentioned, or a reply to the agent, as the platform or the stored quote says. */
  readonly addressed: boolean;
  /** Turns bots started in this chat since a person last spoke there. */
  readonly hops: number;
}

/**
 * - `wake`: hand it to the agent.
 * - `background`: keep it, without waking anyone.
 * - `brake`: a bot asked, but bots have had their turns here; kept as background.
 */
export type Trigger = "wake" | "background" | "brake";

export function trigger(input: TriggerInput): Trigger {
  if (!input.bot) return input.dm || input.addressed ? "wake" : "background";
  if (!input.mentioned) return "background";
  return input.hops >= MAX_BOT_HOPS ? "brake" : "wake";
}

/**
 * Bot turns per chat. In memory: a restart is an interruption of its own, so starting over at 0
 * after one is fine.
 */
export class BotHops {
  private readonly chats = new Map<string, { hops: number; told: boolean }>();

  hops(chatId: string): number {
    return this.chats.get(chatId)?.hops ?? 0;
  }

  /** A person spoke in the chat: bots get their turns back. */
  person(chatId: string): void {
    this.chats.delete(chatId);
  }

  /** A bot started a turn. */
  woke(chatId: string): void {
    const entry = this.chats.get(chatId) ?? { hops: 0, told: false };
    this.chats.set(chatId, { ...entry, hops: entry.hops + 1 });
  }

  /** The brake held. True the first time since a person last spoke: say so once, not on every bot message. */
  braked(chatId: string): boolean {
    const entry = this.chats.get(chatId) ?? { hops: MAX_BOT_HOPS, told: false };
    this.chats.set(chatId, { ...entry, told: true });
    return !entry.told;
  }
}
