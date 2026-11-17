import { randomUUID } from "node:crypto";
import { type Failure, failureOf, type Harness, type HarnessSession } from "../harness/harness.ts";
import { type Agent, type AgentStatus, contactName, type Store } from "../store/store.ts";
import {
  type Action,
  buildColdContext,
  type ColdPolicy,
  DEFAULT_COLD_POLICY,
  describeAction,
  isCold,
  RECENT_ACTIONS,
} from "./cold.ts";
import { formatHandoff, renderMessage } from "./format.ts";
import { MEMORY_LIMIT, memoryHint, memoryHintDue, memorySize, readRole } from "./home.ts";
import { renderManual } from "./manual.ts";

export interface RuntimeDeps {
  readonly store: Store;
  readonly harness: Harness;
  readonly homeDir: string;
  /** Environment for the harness process: API address, token, CLI path. */
  readonly env: () => Readonly<Record<string, string>>;
  /**
   * The agent's own variables, read from the secret store each time a session opens.
   * Undefined when it has none, so opening then takes no extra turn of the event loop.
   */
  readonly agentEnv?: () => Promise<Readonly<Record<string, string>>> | undefined;
  /** Progress inside a turn, for live replies. */
  readonly onActivity?: (kind: "thinking" | "tool", detail?: string) => void;
  /** Messages that will not be answered: given up on after the nudge, or lost to a failed turn. */
  readonly onSettled?: (
    messageIds: readonly string[],
    outcome: "answered" | "unanswered" | "failed" | "waiting",
    why?: FailureInfo,
  ) => void;
  /**
   * Whose usage limit this agent's next session shares: the ledger key (docs/spec.md 4.3).
   * Read again at each open; configuration changes apply to the next session, never mid-turn.
   */
  readonly signIn: () => string;
  /** The current ledger revision of `key`, or undefined while it has no wait. */
  readonly limitRevision: (key: string) => number | undefined;
  /**
   * A session is about to open with sign-in `key`. `changed` is true when it opens on a
   * different sign-in than the session it replaces.
   */
  readonly onSession: (key: string, changed: boolean) => void;
  /**
   * A session on sign-in `key` hit a usage limit and now waits until `until`. Mingle holds the
   * other agents on the same sign-in too: the limit belongs to the account, not to one agent.
   */
  readonly onLimit?: (key: string, until: number, why: FailureInfo) => void;
  /**
   * A turn on sign-in `key` completed: its account works again. `revision` is the ledger
   * revision the turn began with, so a newer quota report is not cleared by an older success.
   */
  readonly onTurnCompleted?: (key: string, revision: number | undefined) => void;
  /** Wait before delivering to an idle agent, so a burst of messages becomes one input. */
  readonly coalesceMs?: number;
  /**
   * After a turn the harness ended without running the model (`TurnEnd.empty`), how long to wait
   * before reminding the agent or giving up on what it has not answered. The harness may still
   * run the input later (earayu/Mingle#125). 0 checks at once, as after any other turn.
   */
  readonly emptyTurnWaitMs?: number;
  /**
   * How long a turn may go without the harness reporting anything before Mingle stops it
   * (earayu/Mingle#127): a command that hangs must not leave the agent working, and every message
   * steered into it unanswered, forever. Undefined uses `STALL_MS`.
   */
  readonly stallMs?: number;
  /**
   * Cold start (docs/spec.md 4.1): when an input meets a large session that sat idle past the
   * prompt cache's lifetime, open a fresh session with a built context instead of resuming. Off
   * unless `rebuild`; cold turns are measured and logged either way, for the comparison.
   */
  readonly coldStart?: { readonly rebuild: boolean; readonly policy?: ColdPolicy };
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Why messages were lost to a failure: its class and, for quota, when the limit resets. */
export interface FailureInfo {
  readonly failure: Failure;
  readonly resetsAt?: number;
  /** For messages left waiting: when Mingle delivers them again. */
  readonly retryAt?: number;
}

/** Waits between tries for a busy or rate-limited provider; after the last, the message fails. */
export const BUSY_RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
/** A usage limit is waited out at most this long at a time, then tried again (and waited again). */
export const QUOTA_WAIT_MS = 3_600_000;
/** A little past the reported reset, so the first try after it is not refused again. */
/** Characters of a person's note shown with their first message in a session. */
const NOTE_CARD_CHARS = 600;
/** How long an empty turn (earayu/Mingle#125) defers the unanswered check. */
const EMPTY_TURN_WAIT_MS = 10 * 60_000;
/**
 * A turn with no harness event for this long is stuck (earayu/Mingle#127). Harnesses cap a
 * foreground command at about 10 minutes (Claude Code's Bash tool, Codex's exec), so twice that
 * in total silence is not work in progress.
 */
export const STALL_MS = 20 * 60_000;
/** How often a silent turn nobody waits on is checked again. */
const STALL_RECHECK_MS = 60_000;
/** After stopping a stuck turn, how long the harness has to end it before its process is replaced. */
const STALL_GRACE_MS = 30_000;

const QUOTA_MARGIN_MS = 15_000;
/** A usage limit that keeps coming back this many times is no longer waited for. */
const MAX_QUOTA_HOLDS = 200;
/**
 * Waits for a usage limit whose reset the harness did not report: longer each time, then hourly,
 * for about a day in all (Raft does the same rather than failing at once). The last entry repeats.
 */
export const QUOTA_UNKNOWN_RETRY_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000];
const MAX_QUOTA_UNKNOWN_HOLDS = 24;

/**
 * When to deliver a message again after `why`, or undefined when it should fail and wait for the
 * owner (docs/spec.md 4.3). Only failures that pass by themselves wait: a usage limit with a
 * known reset, a rate limit, a busy or failing provider. A sign-in, payment or missing harness
 * needs a person, so those fail at once. `holds`: how many times the message already waited.
 */
export function holdUntil(why: FailureInfo, holds: number, now: number): number | undefined {
  switch (why.failure) {
    case "quota":
      if (why.resetsAt && why.resetsAt > now) {
        return holds >= MAX_QUOTA_HOLDS ? undefined : Math.min(why.resetsAt + QUOTA_MARGIN_MS, now + QUOTA_WAIT_MS);
      }
      // No (future) reset reported: still a limit that passes, so wait, longer each time.
      if (holds >= MAX_QUOTA_UNKNOWN_HOLDS) return undefined;
      return now + (QUOTA_UNKNOWN_RETRY_MS[holds] ?? (QUOTA_UNKNOWN_RETRY_MS.at(-1) as number));
    case "rate_limited":
    case "overloaded":
    case "provider": {
      const wait = BUSY_RETRY_MS[holds];
      return wait === undefined ? undefined : now + wait;
    }
    default:
      return undefined;
  }
}

type Pending =
  | { readonly kind: "message"; readonly id: string }
  | { readonly kind: "text"; readonly text: string }
  /** The one reminder about messages the agent has not answered; checked again when delivered. */
  | { readonly kind: "nudge"; readonly ids: readonly string[] }
  | { readonly kind: "handoff"; readonly id: string };

/**
 * One agent, one long-lived harness session (docs/spec.md 4.1–4.3).
 *
 * Messages are pushed into the session: when idle, a short window collects a
 * burst into one new turn; while running, each delivery is steered into the
 * current turn (or queued when the harness cannot steer).
 */
export class AgentRuntime {
  private session: HarnessSession | undefined;
  private opening: Promise<HarnessSession> | undefined;
  private running = false;
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;
  /**
   * Messages the harness queued behind the running turn (`delivered … (queued)`): it runs them as
   * its next turn, so the model has not seen them when this turn ends. Borrowed from Raft's
   * `queuedForNextTurn`: they are not "unanswered" until a turn has run on them.
   */
  private queued = new Set<string>();
  /** The deferred unanswered check after an empty turn. */
  private emptyWait: NodeJS.Timeout | undefined;
  /** Watches the running turn for a stall (earayu/Mingle#127). */
  private stallTimer: NodeJS.Timeout | undefined;
  /** When the harness last reported anything during the running turn. */
  private lastProgress = 0;
  private chain: Promise<void> = Promise.resolve();
  private status: AgentStatus | undefined;
  private disposed = false;
  /** The agent's variables changed during a turn: reopen once it ends. */
  private stale = false;
  /**
   * The owner stopped the agent's work and nothing has been delivered since. A turn the harness
   * begins on its own now (a background command finishing) is aborted, and the agent cannot send.
   */
  private stopped = false;
  /** Messages the owner asked to try again; their next delivery says so. */
  private readonly retried = new Set<string>();
  /** People whose note this session has been shown, so it comes once, with their first message. */
  private readonly introduced = new Set<string>();
  /**
   * The local delivery gate: new messages wait until then instead of failing again. Mingle's
   * account ledger decides when it ends; the owner can still bypass it with a manual retry.
   */
  private blocked: { until: number; why: FailureInfo } | undefined;
  /** The ledger revision the running turn began with, so it clears only the wait it knew. */
  private turnRevision: number | undefined;
  private unblockTimer: NodeJS.Timeout | undefined;
  /** When the agent last finished work, or Mingle last saw it busy: how long the session sat. */
  private idleSince: number;
  /** The root agent's latest tool calls, kept across sessions for a cold start's context. */
  private actions: Action[] = [];
  /** The turn now running met a cold session: measured when it ends (docs/spec.md 12). */
  private coldTurn: { mode: "resume" | "rebuild"; tokens: number | null; idleMs: number } | undefined;
  /** The sign-in the open session runs on; events report under it, whatever config changes to. */
  private sessionSignIn: string;
  /** Bumped when a session is replaced or disposed: a retired session's events are dropped. */
  private generation = 0;

  private readonly agentId: string;
  private readonly deps: RuntimeDeps;

  constructor(agentId: string, deps: RuntimeDeps) {
    this.agentId = agentId;
    this.deps = deps;
    this.sessionSignIn = deps.signIn();
    const last = deps.store.lastMessageTimes(agentId);
    this.idleSince = Math.max(last.inAt ?? 0, last.outAt ?? 0) || this.now();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get id(): string {
    return this.agentId;
  }

  /** The sign-in the open session reports under; configuration changes apply to the next open. */
  get signIn(): string {
    return this.sessionSignIn;
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * Resume pending work after a restart. `after`: wait for it before opening, e.g. for the
   * previous session of this agent to close, so there are never two.
   */
  start(after?: Promise<void>): void {
    // Account waits live in Mingle's ledger; start() restores nothing by itself (docs/spec.md 4.3).
    this.setStatus("idle");
    // Open the session now, not on the first message: startup problems (login,
    // a refused option) surface before anyone chats. No input is delivered here.
    this.chain = this.chain
      .then(() => after)
      .then(async () => {
        if (this.disposed) return;
        await this.ensureSession();
        this.setStatus("idle");
      })
      .catch((error) => this.fail(error));
    for (const message of this.deps.store.undelivered(this.agentId)) this.enqueueMessage(message.id);
    for (const handoff of this.deps.store.waitingHandoffs(this.agentId)) this.enqueueHandoff(handoff.id);
  }

  enqueueMessage(messageId: string): void {
    this.pending.push({ kind: "message", id: messageId });
    this.schedule();
  }

  /**
   * Deliver messages again that were given up on or waited. The store already has them back as
   * received. A retry is a request to try now, so it does not wait out a usage limit.
   */
  retry(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    this.unblock();
    this.resume(messageIds);
  }

  /** A scheduled retry must respect a newer provider-wide quota wait. */
  resume(messageIds: readonly string[], now = Date.now()): void {
    if (this.blocked && this.blocked.until <= now) this.unblock();
    for (const id of messageIds) {
      this.retried.add(id);
      this.enqueueMessage(id);
    }
  }

  /** Input that is not a chat message: a reminder firing, or a note from Mingle itself. */
  enqueueText(text: string): void {
    this.pending.push({ kind: "text", text });
    this.schedule();
  }

  /** What the owner handed over from another conversation (docs/spec.md 4.12): an input of its own. */
  enqueueHandoff(id: string): void {
    if (this.pending.some((p) => p.kind === "handoff" && p.id === id)) return;
    this.pending.push({ kind: "handoff", id });
    this.schedule();
  }

  /** True between an owner's stop and the next input Mingle delivers: the agent may not send. */
  get halted(): boolean {
    return this.stopped;
  }

  /**
   * Stop the agent's work: the current turn and the background tasks it left running, so
   * none of it answers later. Messages in that turn are not nudged about; pending messages
   * stay pending and are delivered as usual. False when there was nothing to stop.
   */
  async stop(): Promise<boolean> {
    if (!this.session) return false;
    // Set before aborting: the harness may begin a turn of its own while the abort is under way.
    this.stopped = true;
    const stopped = (await this.session.abort()) || this.running;
    if (!stopped) this.stopped = false;
    return stopped;
  }

  /** Reopen the session with fresh settings (role or harness changed), serialized with delivery. */
  async restart(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const session = this.session;
        // The old session's events are ignored from here on (docs/spec.md 4.3).
        this.generation++;
        this.session = undefined;
        this.stale = false;
        this.running = false;
        this.clearStall();
        await session?.dispose().catch(() => {});
        if (this.disposed) return;
        await this.ensureSession();
        this.setStatus("idle");
        // Messages that arrived while the brain was broken still need delivering.
        if (this.pending.length > 0) this.flushSoon();
      })
      .catch((error) => this.fail(error));
    await this.chain;
  }

  /** Preserve queued reminders and system notes when replacing a session. */
  takePendingNotes(): string[] {
    const notes = this.pending.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    this.pending = this.pending.filter((p) => p.kind !== "text");
    return notes;
  }

  /**
   * The agent's variables changed. They reach the harness when its process starts, so reopen
   * (resuming the same conversation) now if idle, or after the current turn: never mid-work.
   */
  async refresh(): Promise<void> {
    if (this.running) {
      this.stale = true;
      return;
    }
    await this.restart();
  }

  /**
   * Close the session for good. `final` is the status it leaves behind: offline when Mingle stops
   * or the agent is deleted, paused when the owner pauses it. Nothing the session reports after
   * this point changes the status.
   */
  async dispose(final: "offline" | "paused" = "offline", abortWork = false): Promise<void> {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.emptyWait);
    this.clearStall();
    this.unblock();
    this.pending = [];
    // Written now, not after the session is gone: closing can wait on a session still opening.
    this.deps.store.setAgentStatus(this.agentId, final);
    // Pausing ends the work in hand; the session is closed right after.
    if (abortWork || (final === "paused" && this.running)) await this.session?.abort().catch(() => {});
    await this.chain.catch(() => {});
    await this.session?.dispose().catch(() => {});
    this.session = undefined;
    this.running = false;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.running) {
      this.flushSoon();
      return;
    }
    this.timer ??= setTimeout(() => this.flushSoon(), this.deps.coalesceMs ?? 1000);
  }

  private flushSoon(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(() => this.flush()).catch((error) => this.fail(error));
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0 || this.disposed) return;
    // While a turn runs, only chat messages are steered in. Reminders and notes wait for the
    // next turn: steered at the very end of a turn they could be accepted and never acted on.
    // (A message in that position is still caught by the unanswered check after the turn.)
    const taken = this.running ? this.pending.filter((p) => p.kind === "message") : this.pending.slice();
    this.pending = this.running ? this.pending.filter((p) => p.kind !== "message") : [];
    // A message settled while it waited (answered, or queued twice) is not delivered again.
    // A reminder names only what is still unanswered: the agent may have answered meanwhile (a
    // background command finished and woke it), and a stale reminder makes it answer twice.
    const batch = taken.flatMap((p): Pending[] => {
      if (p.kind === "text") return [p];
      if (p.kind === "handoff") return this.deps.store.handoff(p.id)?.state === "waiting" ? [p] : [];
      if (p.kind === "nudge") {
        const ids = p.ids.filter((id) => this.deps.store.message(id)?.state === "delivered");
        return ids.length > 0 ? [{ kind: "nudge", ids }] : [];
      }
      return this.deps.store.message(p.id)?.state === "received" ? [p] : [];
    });
    if (batch.length === 0) return;
    if (this.blocked && Date.now() >= this.blocked.until) this.unblock();
    if (this.holdBatch(batch)) return;

    const messageIdsInBatch = batch.flatMap((p) => (p.kind === "message" ? [p.id] : []));
    let session: HarnessSession;
    let context = "";
    try {
      const cold = this.running ? undefined : this.coldCheck();
      if (cold?.rebuild) {
        context = this.coldContext(messageIdsInBatch);
        session = await this.reopenFresh(cold.tokens);
      } else {
        session = await this.ensureSession();
      }
    } catch (error) {
      this.coldTurn = undefined;
      this.lose(batch, error);
      throw error;
    }
    if (this.disposed) return;
    // A shared or newly configured quota wait may have appeared while the session opened:
    // hold the batch through the same path rather than deliver into another refusal.
    if (this.blocked && Date.now() >= this.blocked.until) this.unblock();
    if (this.holdBatch(batch)) return;
    const inputId = randomUUID();
    // New input: whatever comes next is work Mingle asked for, not the stopped work resuming.
    this.stopped = false;
    // Mark first: a fast agent can reply before deliver() returns, and its reply must win.
    const delivered = new Set(
      this.deps.store.moveInbound(
        batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
        "deliver",
        inputId,
      ),
    );
    const messageIds = [...delivered];
    const text = batch
      .flatMap((p) => {
        if (p.kind === "text") return [p.text];
        if (p.kind === "nudge") return [nudgeText(p.ids)];
        if (p.kind === "handoff") {
          const handoff = this.deps.store.handoff(p.id);
          return handoff ? [formatHandoff(handoff)] : [];
        }
        return delivered.has(p.id) ? [this.render(p.id)] : [];
      })
      .filter(Boolean)
      .join("\n\n");
    if (!text) {
      this.coldTurn = undefined;
      return;
    }
    // What the owner changed from the console rides along; it never starts a turn of its own.
    const notes = this.deps.store.ownerNotes(this.agentId);
    const told = notes.length > 0 ? `${notes.map((n) => n.body).join("\n")}\n\n${text}` : text;
    const input = context ? `${context}\n\n${told}` : told;
    let result: Awaited<ReturnType<HarnessSession["deliver"]>>;
    try {
      result = await session.deliver(input, inputId);
    } catch (error) {
      this.lose(batch, error);
      throw error;
    }
    if (result.outcome === "rejected") {
      const error = new Error(`the harness refused the input (${result.reason ?? "no reason"})`);
      this.lose(batch, error);
      throw error;
    }
    this.deps.store.deleteOwnerNotes(
      this.agentId,
      notes.map((n) => n.id),
    );
    this.deps.store.markHandoffsDelivered(batch.flatMap((p) => (p.kind === "handoff" ? [p.id] : [])));
    if (result.outcome === "queued") for (const id of messageIds) this.queued.add(id);
    this.deps.log?.(`${this.agentId}: delivered ${messageIds.join(",") || "note"} (${result.outcome})`);
  }

  /**
   * Whether the input about to be delivered meets a cold session (docs/spec.md 4.1). Any turn after
   * a long idle is marked for measurement; `rebuild` when a fresh session should replace it.
   */
  private coldCheck(): { rebuild: boolean; tokens: number | null } | undefined {
    const session = this.session;
    if (!session) return undefined;
    const now = this.now();
    const policy = this.deps.coldStart?.policy ?? DEFAULT_COLD_POLICY;
    const idleMs = now - this.idleSince;
    if (idleMs <= policy.idleMs) return undefined;
    const tokens = session.contextTokens?.() ?? null;
    const rebuild =
      this.deps.coldStart?.rebuild === true &&
      isCold({ running: false, idleSince: this.idleSince, tokens }, now, policy);
    this.coldTurn = { mode: rebuild ? "rebuild" : "resume", tokens, idleMs };
    return { rebuild, tokens };
  }

  private coldContext(exclude: readonly string[]): string {
    return buildColdContext({
      store: this.deps.store,
      agentId: this.agentId,
      agentName: this.agent().name,
      homeDir: this.deps.homeDir,
      actions: this.actions,
      exclude,
      now: this.now(),
    });
  }

  /**
   * Close the cold session and open a fresh one in its place. The old session's id is kept as the
   * previous one, so the switch can be undone. If the fresh one fails to open, the agent still
   * points at the old session, and the next input resumes it.
   */
  private async reopenFresh(tokens: number | null): Promise<HarnessSession> {
    const old = this.session;
    // The cold session's events are ignored from here on, as on any replacement.
    this.generation++;
    this.session = undefined;
    await old?.dispose().catch(() => {});
    this.opening ??= this.open(true).finally(() => {
      this.opening = undefined;
    });
    const session = await this.opening;
    this.deps.log?.(
      `${this.agentId}: cold start: opened ${session.id} in place of ${old?.id ?? "none"} (context ${tokens ?? "?"} tokens)`,
    );
    return session;
  }

  /**
   * Input that could not be handed over. Chat messages settle as failed, so the person
   * hears about it instead of waiting; reminders and notes wait for the next turn.
   */
  private lose(batch: readonly Pending[], error: unknown): void {
    if (this.disposed) return;
    this.pending.unshift(...batch.filter((p) => p.kind !== "message"));
    this.settleLost(
      batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
      { failure: failureOf(error) },
    );
  }

  /**
   * Messages the agent could not answer because of `why`: each waits and is delivered again when
   * the failure passes by itself, or fails for the owner to retry or ignore (docs/spec.md 4.3).
   */
  private settleLost(ids: readonly string[], why: FailureInfo): void {
    if (this.disposed || ids.length === 0) return;
    const now = Date.now();
    const waits = new Map<number, string[]>();
    const failing: string[] = [];
    for (const id of ids) {
      const at = holdUntil(why, this.deps.store.holds(id), now);
      if (at === undefined) failing.push(id);
      else waits.set(at, [...(waits.get(at) ?? []), id]);
    }
    for (const [at, group] of waits) {
      const held = this.deps.store.moveInbound(group, "hold", undefined, at);
      if (held.length > 0) this.deps.onSettled?.(held, "waiting", { ...why, retryAt: at });
    }
    // Quota waits are logged where the hold begins (block); these are the passing failures
    // that have no other trace in the log until the retry.
    if (why.failure !== "quota") {
      const held = [...waits.values()].reduce((n, group) => n + group.length, 0);
      if (held > 0) this.deps.log?.(`${this.agentId}: ${held} message(s) waiting to retry (${why.failure})`);
    }
    // A usage limit holds for everything after it too, until the reset. Mingle's account ledger
    // decides the shared deadline; without a ledger this runtime still gates itself.
    if (why.failure === "quota" && waits.size > 0) {
      const top = Math.max(...waits.keys());
      if (this.deps.onLimit) this.deps.onLimit(this.sessionSignIn, top, why);
      else this.block(top, why);
    }
    const failed = this.deps.store.moveInbound(failing, "fail");
    if (failed.length > 0) this.deps.onSettled?.(failed, "failed", why);
  }

  /**
   * Hold `batch` for the wait in force: its messages go to `waiting` until `blocked.until`, and
   * its reminders and notes go back to pending rather than being delivered into a refusal.
   */
  private holdBatch(batch: readonly Pending[]): boolean {
    if (!this.blocked) return false;
    const { until, why } = this.blocked;
    const held = this.deps.store.moveInbound(
      batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
      "hold",
      undefined,
      until,
    );
    if (held.length > 0) this.deps.onSettled?.(held, "waiting", { ...why, retryAt: until });
    this.pending.unshift(...batch.filter((p) => p.kind !== "message"));
    return true;
  }

  /** The usage-limit wait in force, if any, for agents added later on the same sign-in. */
  get limit(): { until: number; why: FailureInfo } | undefined {
    return this.blocked && this.blocked.until > Date.now()
      ? { until: this.blocked.until, why: this.blocked.why }
      : undefined;
  }

  /**
   * Mingle's account ledger says this session's sign-in hit its usage limit: wait it out rather
   * than deliver only to fail the same way. A later wait already in place is kept.
   */
  holdFor(until: number, why: FailureInfo): void {
    if (this.disposed || until <= Date.now() || (this.blocked && this.blocked.until >= until)) return;
    this.block(until, why);
  }

  /**
   * The ledger wait on this session's sign-in ended: drop the local gate and deliver anything
   * pending. Waiting messages are Mingle's to deliver again.
   */
  release(): void {
    if (this.disposed) return;
    this.unblock();
    if (this.pending.length > 0) this.flushSoon();
  }

  private block(until: number, why: FailureInfo): void {
    this.unblock();
    this.blocked = { until, why };
    this.deps.log?.(
      `${this.agentId}: usage limit wait until ${new Date(until).toISOString()}${why.resetsAt ? ` (resets ${new Date(why.resetsAt).toISOString()})` : ""}`,
    );
    // The local gate opens locally at the deadline; the ledger entry survives it, so a turn that
    // succeeds after it can end the wait for every agent on the sign-in.
    this.unblockTimer = setTimeout(
      () => {
        this.unblock();
        if (this.pending.length > 0) this.flushSoon();
      },
      Math.max(0, until - Date.now()),
    );
    this.unblockTimer.unref?.();
  }

  private unblock(): void {
    clearTimeout(this.unblockTimer);
    this.unblockTimer = undefined;
    this.blocked = undefined;
  }

  private render(messageId: string): string {
    const { store } = this.deps;
    const message = store.message(messageId);
    const chat = message && store.chat(message.chatId);
    if (!message || !chat) return "";
    // In a group, how much was said there without the agent, so it can read back when it matters.
    const unseen = chat.kind === "dm" ? 0 : store.unseen(chat.id, message.createdAt);
    const rendered = renderMessage(store, message, { unseen });
    if (!rendered) return "";
    const text = `${this.introduce(message.senderId, chat.connectionId)}${rendered}`;
    if (!this.retried.delete(messageId)) return text;
    // An old message coming back: the agent should know it is late, not treat it as new.
    return `[mingle] Retry: ${message.id} was not answered when it arrived (see its time). Reply to it now, and say briefly that the answer is late.\n${text}`;
  }

  /**
   * Who the sender is, the first time they speak in this session (borrowed from Raft's peer card):
   * where they sit in the organization, as the chat app says, and what the agent wrote down about
   * them, in front of it without a lookup. Empty when there is neither, or it was already shown.
   */
  private introduce(senderId: string | null, connectionId: string): string {
    const { store } = this.deps;
    const contact = senderId ? store.contactByPlatformId(connectionId, senderId) : undefined;
    if (!contact) return "";
    const key = contact.personId ?? contact.id;
    if (this.introduced.has(key)) return "";
    const note = contact.personId ? store.agentPerson(this.agentId, contact.personId)?.note?.trim() : undefined;
    if (!note && !contact.profile) return "";
    this.introduced.add(key);
    const name = contactName(contact) ?? contact.id;
    const lines = [`[mingle] About ${name} (${contact.id})${contact.profile ? `: ${contact.profile}` : ""}`];
    if (note) {
      const short =
        note.length > NOTE_CARD_CHARS ? `${note.slice(0, NOTE_CARD_CHARS)}… (rest: contact info ${contact.id})` : note;
      lines.push(`Your note: ${short}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private async ensureSession(): Promise<HarnessSession> {
    if (this.session) return this.session;
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(fresh = false): Promise<HarnessSession> {
    // The sign-in this session will run on, fixed before anything async: everything the session
    // reports later (quota waits, completed turns) is accounted under this key, never under
    // whatever the configuration changed to while the session lived. Reading the secret store
    // yields, so the configuration — sign-in AND the credentials themselves — is sampled again
    // each pass until a consistent pair survives a whole read; a stale snapshot is never given
    // to the harness. A disposed or replaced runtime stops here, before it can call onSession.
    const gen = this.generation;
    let agent: Agent;
    let key: string;
    let own: Readonly<Record<string, string>>;
    for (;;) {
      if (this.disposed || gen !== this.generation) throw new Error("agent runtime disposed");
      agent = this.agent();
      key = this.deps.signIn();
      // A harness whose shell gets no environment (Cursor) gets none of the agent's variables
      // either, and the guide does not name them. Values never go into the prompt.
      const reading = this.deps.harness.acceptsEnv?.(agent.harness) === false ? undefined : this.deps.agentEnv?.();
      own = reading ? await reading : {};
      if (this.disposed || gen !== this.generation) throw new Error("agent runtime disposed");
      if (key === this.deps.signIn()) break;
    }
    const changed = this.sessionSignIn !== key;
    this.sessionSignIn = key;
    this.deps.onSession(key, changed);
    const session = await this.deps.harness.open(
      {
        harness: agent.harness,
        model: agent.model,
        cwd: this.deps.homeDir,
        resume: fresh ? null : agent.sessionId,
        appendSystemPrompt: renderManual(agent.name, readRole(this.deps.homeDir), process.platform, Object.keys(own)),
        // Mingle's own variables win over the agent's.
        env: { ...own, ...this.deps.env() },
      },
      {
        onTurnStarted: (self) => {
          if (this.disposed || gen !== this.generation) return;
          if (self && this.stopped) {
            // The stopped work coming back (a background command ended and woke the agent).
            this.deps.log?.(`${this.agentId}: aborted a turn the harness began after a stop`);
            void this.session?.abort().catch(() => {});
          }
          this.running = true;
          // The harness runs what it queued as the turn it starts for a prompt.
          if (!self) this.queued.clear();
          this.watchStall();
          this.turnRevision = this.deps.limitRevision(key);
          this.setStatus("thinking");
          this.deps.onActivity?.("thinking");
        },
        onTurnEnded: (outcome) => {
          if (this.disposed || gen !== this.generation) return;
          this.running = false;
          this.clearStall();
          this.idleSince = this.now();
          if (outcome.kind === "failed") {
            const failure = outcome.failure ?? "unknown";
            this.deps.log?.(`${this.agentId}: turn failed (${failure}${outcome.reason ? `: ${outcome.reason}` : ""})`);
            this.setStatus("error", outcome.reason ?? "the turn failed", failure);
            // The agent did not get to answer: say so now rather than nudge it into the same failure.
            this.settleAwaiting({ failure, ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}) });
          } else {
            this.setStatus("idle");
          }
          // The sign-in answered: any usage-limit wait on it is over, for every agent sharing it.
          if (outcome.kind === "completed") this.deps.onTurnCompleted?.(key, this.turnRevision);
          this.turnRevision = undefined;
          if (outcome.kind === "completed" && outcome.empty) this.afterEmptyTurn();
          else {
            clearTimeout(this.emptyWait);
            this.emptyWait = undefined;
            this.afterTurn(outcome.kind === "completed");
          }
        },
        onActivity: (kind, detail) => {
          if (this.disposed || gen !== this.generation) return;
          this.lastProgress = this.now();
          this.setStatus(kind === "tool" ? "working" : "thinking", detail ?? null);
          this.deps.onActivity?.(kind, detail);
        },
        onAction: (tool, input) => {
          if (this.disposed || gen !== this.generation) return;
          this.lastProgress = this.now();
          this.actions.push({ at: this.now(), text: describeAction(tool, input) });
          if (this.actions.length > RECENT_ACTIONS) this.actions.splice(0, this.actions.length - RECENT_ACTIONS);
        },
        onProgress: () => {
          if (gen === this.generation) this.lastProgress = this.now();
        },
        onTurnUsage: (usage) => {
          if (gen !== this.generation) return;
          const cold = this.coldTurn;
          if (!cold) return;
          this.coldTurn = undefined;
          // The cold-start comparison (docs/spec.md 12): what the first turn after a long idle cost.
          this.deps.log?.(
            `${this.agentId}: cold turn mode=${cold.mode} idle=${Math.round(cold.idleMs / 60_000)}m context=${cold.tokens ?? "?"} input=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} output=${usage.output}`,
          );
        },
      },
    );
    if (this.disposed || gen !== this.generation) {
      // Stopped or replaced while the open was in flight: drop it, don't keep it.
      await session.dispose();
      throw new Error("agent runtime disposed");
    }
    if (agent.sessionId && !session.resumed) {
      this.deps.log?.(`${this.agentId}: session ${agent.sessionId} was gone; opened ${session.id}`);
    } else {
      this.deps.log?.(`${this.agentId}: session ${session.id} ${session.resumed ? "resumed" : "opened"}`);
    }
    // A new conversation has seen nobody's note yet.
    if (!session.resumed) this.introduced.clear();
    if (fresh) this.deps.store.replaceSession(this.agentId, session.id);
    else this.deps.store.setSessionId(this.agentId, session.id);
    this.session = session;
    // What the previous session queued is gone with it: nothing still waits on a turn there.
    this.queued.clear();
    return session;
  }

  /**
   * The harness answered the input without running the model on it (earayu/Mingle#125). It may
   * have queued it behind a turn of its own, so the model can still answer later: reminding now
   * would only queue the reminder too, and giving up a second later would be wrong. Deliver what
   * else is pending, and check what is unanswered after a while, or after the next real turn.
   */
  private afterEmptyTurn(): void {
    const wait = this.deps.emptyTurnWaitMs ?? EMPTY_TURN_WAIT_MS;
    if (wait <= 0) {
      this.afterTurn(true);
      return;
    }
    if (this.disposed) return;
    this.deps.log?.(
      `${this.agentId}: the harness ended a turn without running it; checking replies in ${Math.round(wait / 1000)}s`,
    );
    if (!this.emptyWait) {
      this.emptyWait = setTimeout(() => {
        this.emptyWait = undefined;
        if (this.disposed) return;
        // A turn is running (the harness got to the input): its end does the check.
        if (!this.running) this.afterTurn(false);
      }, wait);
      this.emptyWait.unref?.();
    }
    if (this.stale) {
      void this.restart();
      return;
    }
    if (this.pending.length > 0) this.flushSoon();
  }

  /**
   * The agent called Mingle (a `mingle` command reached the local API): it is alive, whatever the
   * harness reports. Raft counts such internal progress the same way.
   */
  noteProgress(): void {
    if (this.running) this.lastProgress = this.now();
  }

  /**
   * Watch the turn that just began: if the harness reports nothing for `stallMs` the turn is stuck
   * (a command that never ends), and steered messages would wait in it forever. One timer per
   * turn, re-armed for whatever is left since the last event. A silent turn nobody waits on is left
   * alone (Raft's "stalled with work"): it may be a long job the agent took on, and stopping it
   * helps no one; it is stopped once a message arrives and waits on it.
   */
  private watchStall(): void {
    this.lastProgress = this.now();
    if (this.stallTimer) return;
    const limit = this.deps.stallMs ?? STALL_MS;
    const check = (wait: number) => {
      this.stallTimer = setTimeout(() => {
        this.stallTimer = undefined;
        if (this.disposed || !this.running) return;
        const quiet = this.now() - this.lastProgress;
        if (quiet < limit) check(limit - quiet);
        else if (this.waitedOn()) void this.unstick(quiet);
        // Checked again soon: a message steered in now should not wait a whole limit more.
        else check(Math.min(limit, STALL_RECHECK_MS));
      }, wait);
      this.stallTimer.unref?.();
    };
    check(limit);
  }

  /** Messages wait on the running turn: delivered into it, or queued behind it, and unanswered. */
  private waitedOn(): boolean {
    return this.deps.store.awaitingReply(this.agentId).length > 0;
  }

  private clearStall(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  /**
   * Stop a stuck turn the way `/stop` would, but as Mingle's own way out rather than the owner's:
   * what the turn left unanswered is reminded about as after any turn, so the agent answers in a
   * fresh one (or the messages end as not answered). If the harness does not end the turn, its
   * session is replaced: the process and the command it hangs on go with it.
   */
  private async unstick(quiet: number): Promise<void> {
    const session = this.session;
    const gen = this.generation;
    if (!session) return;
    this.deps.log?.(`${this.agentId}: the turn made no progress for ${Math.round(quiet / 60_000)}m; stopping it`);
    // The grace period starts now, not when the abort returns: a hung harness may never answer it.
    const grace = Math.min(STALL_GRACE_MS, this.deps.stallMs ?? STALL_MS);
    const timer = setTimeout(() => {
      if (this.disposed || gen !== this.generation || !this.running) return;
      this.deps.log?.(`${this.agentId}: the harness did not end the stuck turn; reopening its session`);
      this.generation++;
      this.session = undefined;
      this.running = false;
      this.clearStall();
      this.turnRevision = undefined;
      this.idleSince = this.now();
      // What the old process queued goes with it: those messages are reminded about too.
      this.queued.clear();
      void session.dispose().catch(() => {});
      this.setStatus("idle");
      // The next input (the reminder) resumes the conversation in a new process.
      this.afterTurn(false);
    }, grace);
    timer.unref?.();
    await session.abort().catch(() => false);
  }

  /** After each turn: remind the agent once about messages it has not answered (docs/spec.md 4.3). */
  private afterTurn(completed = false): void {
    if (this.disposed) return;
    const { store } = this.deps;
    // Still queued behind this turn: the model has not seen them yet, so neither remind nor give up.
    const awaiting = store.awaitingReply(this.agentId).filter((m) => !this.queued.has(m.id));
    // After the owner's stop, a nudge would restart the work they stopped: what is
    // unanswered is marked so at once, for the owner to retry or ignore.
    const fresh = this.stopped ? [] : awaiting.filter((m) => !store.wasNudged(m.id));
    const stale = this.stopped ? awaiting : awaiting.filter((m) => store.wasNudged(m.id));
    // Reminded once and still not quoted, but the agent did speak in that chat afterwards (it
    // answered by quoting another message there, or one answer covered several messages): the
    // person has their answer, so the message ends as answered, not "no reply yet".
    const covered = this.stopped ? [] : stale.filter((m) => store.spokeSince(m.chatId, m.createdAt));
    const answered = store.moveInbound(
      covered.map((m) => m.id),
      "send",
    );
    if (answered.length > 0) this.deps.onSettled?.(answered, "answered");
    const givenUp = store.moveInbound(
      stale.filter((m) => !covered.includes(m)).map((m) => m.id),
      "give_up",
    );
    if (givenUp.length > 0) {
      this.deps.log?.(`${this.agentId}: gave up on ${givenUp.length} unanswered message(s)`);
      this.deps.onSettled?.(givenUp, "unanswered");
    }
    if (fresh.length > 0) {
      store.markNudged(fresh.map((m) => m.id));
      this.pending.push({ kind: "nudge", ids: fresh.map((m) => m.id) });
    }
    // Only after work that finished, with nothing else waiting: the hint never interrupts or joins other work.
    if (completed && !this.stopped && this.pending.length === 0) this.checkMemory();
    if (this.stale) {
      // restart() delivers what is pending once the new process is up.
      void this.restart();
      return;
    }
    if (this.pending.length > 0) this.flushSoon();
  }

  /** Ask the agent to trim MEMORY.md when it has grown too large (docs/spec.md 4.5). */
  private checkMemory(): void {
    const size = memorySize(this.deps.homeDir);
    const now = Date.now();
    const last = this.deps.store.memoryHint(this.agentId);
    // Trimmed back under the limit: the hint has done its job, so growing past it again is news
    // and is told at once, not a day after the last hint.
    if (last && size <= MEMORY_LIMIT) {
      this.deps.store.setMemoryHint(this.agentId, null, null);
      return;
    }
    if (!memoryHintDue(size, last, now)) return;
    this.deps.store.setMemoryHint(this.agentId, now, size);
    this.deps.log?.(`${this.agentId}: MEMORY.md is ${size} bytes; asked the agent to trim it`);
    this.pending.push({ kind: "text", text: memoryHint(size) });
  }

  private agent(): Agent {
    const agent = this.deps.store.agent(this.agentId);
    if (!agent) throw new Error(`agent ${this.agentId} no longer exists`);
    return agent;
  }

  private setStatus(status: AgentStatus, detail: string | null = null, failure: Failure | null = null): void {
    // A late report from a closed session (a turn ending after it was aborted) must not overwrite
    // the status dispose() left: a paused agent stays paused.
    if (this.disposed) return;
    if (this.status === status && status !== "working" && status !== "error") return;
    this.status = status;
    this.deps.store.setAgentStatus(this.agentId, status, detail, failure);
  }

  /** Every message still waiting on this agent's answer was lost to `why`. */
  private settleAwaiting(why: FailureInfo): void {
    this.settleLost(
      this.deps.store.awaitingReply(this.agentId).map((m) => m.id),
      why,
    );
  }

  private fail(error: unknown): void {
    if (this.disposed) return; // A stopped or deleted agent stays offline, not error.
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log?.(`${this.agentId}: ${message}`);
    // Reopen (resuming the same conversation) on the next input.
    const session = this.session;
    this.generation++;
    this.session = undefined;
    this.running = false;
    this.clearStall();
    void session?.dispose().catch(() => {});
    const failure = failureOf(error);
    this.setStatus("error", message, failure);
    this.settleAwaiting({ failure });
  }
}

function nudgeText(ids: readonly string[]): string {
  return `[mingle] Not answered yet: ${ids.join(", ")}. Reply to each with "$MINGLE_CLI" message reply <id>; a short acknowledgement is enough when your answer is already elsewhere in the chat. A message left without any reply is shown to its sender as not answered.`;
}
