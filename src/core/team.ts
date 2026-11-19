import { randomBytes } from "node:crypto";
import { copyFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  Capabilities,
  ChannelConnection,
  ChatRef,
  InboundAttachment,
  OutboundMessage,
  SendResult,
} from "../channels/channel.ts";
import type { Agent, Store } from "../store/store.ts";
import { MingleError } from "./errors.ts";

/**
 * Teams (docs/spec.md 4.13): an agent may lead a few others on this computer. The lead and each
 * member share a direct chat that never leaves the machine; that chat is all there is to it.
 */

/** Turns two agents may start each other on before Mingle stops their chat (docs/spec.md 4.13). */
export const MAX_TEAM_HOPS = 20;

/** Why `member` cannot join `lead`'s team, or undefined when it can. One level, one team each. */
export function teamRefusal(store: Store, lead: Agent, member: Agent): MingleError | undefined {
  if (lead.id === member.id) return new MingleError("team_self", "an agent cannot be in its own team", 409);
  if (lead.leadId) {
    const name = store.agent(lead.leadId)?.name ?? "another agent";
    return new MingleError("team_lead_is_member", `${lead.name} is in ${name}'s team, so it cannot lead one`, 409);
  }
  if (store.members(member.id).length > 0) {
    return new MingleError("team_member_leads", `${member.name} leads a team of its own`, 409);
  }
  if (member.leadId && member.leadId !== lead.id) {
    const name = store.agent(member.leadId)?.name ?? "another agent";
    return new MingleError("team_member_taken", `${member.name} is already in ${name}'s team`, 409);
  }
  return undefined;
}

/** The two agents are lead and member of one team, either way round. */
export function teamPair(store: Store, a: string, b: string): boolean {
  const one = store.agent(a);
  const other = store.agent(b);
  return Boolean(one && other && (one.leadId === other.id || other.leadId === one.id));
}

/** What the agent's guide says about its team, or undefined when it has none. */
export function teamRole(
  store: Store,
  agent: Agent,
): { role: "lead"; members: readonly string[] } | { role: "member"; lead: string } | undefined {
  if (agent.leadId) {
    const lead = store.agent(agent.leadId);
    return lead ? { role: "member", lead: lead.name } : undefined;
  }
  const members = store.members(agent.id);
  return members.length ? { role: "lead", members: members.map((m) => m.name) } : undefined;
}

export interface TeamSend {
  readonly from: string;
  readonly to: string;
  readonly platformId: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly files: readonly InboundAttachment[];
}

/**
 * One agent's end of its team chats, as a chat app connection: what it sends is handed to the other
 * agent's end by `deliver`, on this computer. Files stay where they are; the other side copies them.
 */
export class TeamLink implements ChannelConnection {
  readonly bot: { id: string; name: string };
  private readonly deliver: (send: TeamSend) => SendResult;
  private readonly allowed: (to: string) => boolean;

  constructor(
    agent: { id: string; name: string },
    deliver: (send: TeamSend) => SendResult,
    allowed: (to: string) => boolean,
  ) {
    this.bot = { id: agent.id, name: agent.name };
    this.deliver = deliver;
    this.allowed = allowed;
  }

  capabilities(): Capabilities {
    return {
      quoteReply: true,
      reactions: false,
      typingIndicator: false,
      fileUpload: true,
      fileDownload: true,
      listMembers: false,
      maxTextLength: 20_000,
    };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const platformId = `tm_${randomBytes(6).toString("base64url")}`;
    return this.deliver({
      from: this.bot.id,
      to: message.chat.platformId,
      platformId,
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      files: (message.files ?? []).map((f) => ({ id: f.path, name: f.name ?? basename(f.path) })),
    });
  }

  async react(): Promise<void> {}
  async setTyping(): Promise<void> {}

  async download(attachment: InboundAttachment, toPath: string): Promise<void> {
    await copyFile(attachment.id, toPath);
  }

  /** The direct chat with a teammate is named by the teammate's agent ID. */
  async openDirect(userId: string): Promise<string> {
    if (!this.allowed(userId)) throw new Error("not in the same team");
    return userId;
  }

  async listMembers(_chat: ChatRef): Promise<readonly never[]> {
    return [];
  }

  async close(): Promise<void> {}
}

/**
 * Turns team chats started without a person speaking, per pair of agents. The counts are in memory
 * and start over after a restart; a stopped pair is found again from its held messages
 * (`Mingle.restoreTeamStops`), so what waits for the owner never gets lost. A person writing to
 * either agent gives the pair its turns back.
 */
export class TeamHops {
  private readonly pairs = new Map<string, { hops: number; stoppedAt: number | null }>();

  static key(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Count a turn; true when this one is past the limit and must wait for the owner. */
  woke(a: string, b: string, now = Date.now()): boolean {
    const key = TeamHops.key(a, b);
    const entry = this.pairs.get(key) ?? { hops: 0, stoppedAt: null };
    if (entry.stoppedAt !== null || entry.hops >= MAX_TEAM_HOPS) {
      this.pairs.set(key, { hops: entry.hops, stoppedAt: entry.stoppedAt ?? now });
      return true;
    }
    this.pairs.set(key, { hops: entry.hops + 1, stoppedAt: null });
    return false;
  }

  /** A person wrote to this agent: every chat it has with its team starts counting again. */
  person(agentId: string): void {
    for (const [key, entry] of this.pairs) {
      if (entry.stoppedAt === null && key.split("|").includes(agentId)) this.pairs.delete(key);
    }
  }

  /** Mark a pair stopped, as found in the store after a restart. */
  stop(a: string, b: string, at: number): void {
    const key = TeamHops.key(a, b);
    const entry = this.pairs.get(key);
    this.pairs.set(key, { hops: entry?.hops ?? MAX_TEAM_HOPS, stoppedAt: Math.min(entry?.stoppedAt ?? at, at) });
  }

  /** The owner let the pair go on. */
  release(a: string, b: string): void {
    this.pairs.delete(TeamHops.key(a, b));
  }

  /** When the pair was stopped, or null. */
  stoppedAt(a: string, b: string): number | null {
    return this.pairs.get(TeamHops.key(a, b))?.stoppedAt ?? null;
  }
}
