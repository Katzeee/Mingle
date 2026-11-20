import { describe, expect, it } from "vitest";
import { cueIn, defaultTier, ENGAGE, HearingBook, type HearTier, nameIn, type Stretch } from "../src/core/hearing.ts";

/** The pace of a group that hears everything, on a fake clock (docs/spec.md 4.2, RFC 0001). */
const pace = { quietMs: 20_000, maxWaitMs: 60_000, gapMs: 120_000 };
const book = () => new HearingBook(() => pace);
const at = (s: number) => s * 1000;

function say(b: HearingBook, who: string, t: number, o: { named?: boolean; chat?: string; tier?: HearTier } = {}) {
  return b.observe({
    chatId: o.chat ?? "c1",
    groupId: "c1",
    senderId: who,
    at: t,
    now: t,
    named: o.named ?? false,
    owner: false,
    tier: o.tier ?? "fast",
  });
}

function handOver(b: HearingBook, t: number, chat = "c1"): Stretch {
  const r = b.handOver(chat, t);
  if (!r || !("stretch" in r)) throw new Error(`nothing handed over at ${t}`);
  return r.stretch;
}

describe("the pace of a group that hears everything", () => {
  it("keeps Mingle's own pace while nobody is in a conversation", () => {
    const b = book();
    expect(say(b, "u1", at(0))).toEqual({ lane: "slow", dueAt: at(20), reset: true });
    const s = handOver(b, at(20));
    b.settle(s, false, at(50));
    // The gap counts from the last stretch handed over.
    expect(say(b, "u1", at(60)).dueAt).toBe(at(140));
  });

  it("goes fast for someone the agent answered, without the gap, and ends their turn at their rhythm", () => {
    const b = book();
    say(b, "u1", at(0));
    b.settle(handOver(b, at(20)), true, at(50));
    b.spoke("c1", "c1", ["u1"], at(50));
    const plan = say(b, "u1", at(60));
    expect(plan.lane).toBe("fast");
    // E is a little under 1 ten seconds on: about the 8 s default turn end, well before the 2 min gap.
    expect(plan.dueAt).toBeGreaterThan(at(68));
    expect(plan.dueAt).toBeLessThan(at(69));
    // Their lines 3 s apart teach it their rhythm: the window shrinks toward 3 s (mixed with the
    // usual 20 s by how much E has faded since the answer).
    for (const t of [63, 66, 69, 72]) say(b, "u1", at(t));
    const last = say(b, "u1", at(75));
    expect(last.dueAt - at(75)).toBeLessThan(at(6));
  });

  it("never waits more than the fast lane's longest wait while someone keeps typing", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    say(b, "u1", at(0));
    let plan = say(b, "u1", at(0));
    for (let t = 1; t <= 30; t += 1) plan = say(b, "u1", at(t));
    // The longest wait is 15 s at E = 1, mixed toward 60 s as E fades: E is 0.84 by 30 s.
    expect(plan.dueAt).toBeLessThanOrEqual(at(23));
  });

  it("lets others ride along while someone is in a conversation, at most four minutes", () => {
    const b = book();
    say(b, "u1", at(0));
    b.settle(handOver(b, at(20)), true, at(40));
    b.spoke("c1", "c1", ["u1"], at(40));
    // Chatter first, with nobody else's stretch waiting: held, not handed over at the usual pace.
    const chatter = say(b, "u2", at(45));
    expect(chatter.lane).toBe("ride");
    expect(chatter.dueAt).toBe(at(20 + 240));
    // The person in the conversation moves the clock; chatter after that leaves it be.
    const fast = say(b, "u1", at(50));
    expect(fast.lane).toBe("fast");
    expect(say(b, "u2", at(51))).toEqual({ lane: "ride", dueAt: fast.dueAt, reset: false });
    const s = handOver(b, fast.dueAt);
    expect([...s.engaged]).toEqual(["u1"]);
    expect([...s.heard].sort()).toEqual(["u1", "u2"]);
  });

  it("takes a name as a call, and less so each time it went unanswered", () => {
    const b = book();
    for (let n = 0; n < 2; n++) {
      const t = at(n * 30);
      expect(say(b, "joker", t, { named: true }).lane).toBe("fast");
      b.settle(handOver(b, t + at(10)), false, t + at(20));
    }
    // Ignored twice: the name no longer makes them a conversation.
    expect(say(b, "joker", at(60), { named: true }).lane).toBe("slow");
    // Answered once, and it counts again.
    b.drop("c1");
    b.spoke("c1", "c1", ["joker"], at(70));
    expect(say(b, "joker", at(71), { named: true }).lane).toBe("fast");
  });

  it("caps what one person can spend with their own bucket, and leaves the rest of the group's", () => {
    const b = book();
    let t = 0;
    let fast = 0;
    for (let n = 0; n < 6; n++) {
      t += at(30);
      // Answered somewhere each time, so only their bucket can stop them.
      b.spoke("c1", "c1", ["joker"], t);
      if (say(b, "joker", t).lane === "fast") fast++;
      const r = b.handOver("c1", t + at(10));
      if (r && "stretch" in r) b.settle(r.stretch, false, t + at(12));
    }
    // Three tokens, a tenth of one back in each 30 s: three fast stretches, then no more.
    expect(fast).toBe(3);
    // Someone the agent answers still goes fast: the group's bucket is not spent.
    b.spoke("c1", "c1", ["bryce"], t + at(20));
    expect(say(b, "bryce", t + at(21)).lane).toBe("fast");
  });

  it("holds the tokens of a fast stretch from hand-over, so stretches on the way cannot overdraw", () => {
    const b = new HearingBook(() => pace, { tiers: { ...ENGAGE.tiers, save: { cap: 2, refillMs: 1e12 } } });
    for (const who of ["a", "b", "c"]) b.spoke("c1", "c1", [who], 0);
    const handed: Stretch[] = [];
    // Three threads of one group, each with a fast stretch, none settled yet.
    for (const [i, who] of ["a", "b", "c"].entries()) {
      say(b, who, at(1), { chat: `t${i}`, tier: "save" });
      const r = b.handOver(`t${i}`, at(10));
      if (r && "stretch" in r) handed.push(r.stretch);
    }
    expect(handed.filter((s) => s.reserved)).toHaveLength(2);
    // Answered: the tokens come back.
    b.settle(handed[0] as Stretch, true, at(20));
    expect(say(b, "a", at(21), { chat: "t0", tier: "save" }).lane).toBe("fast");
  });

  it("never wastes more fast stretches than the group's bucket allows (property)", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const tier = ENGAGE.tiers.balanced;
    const b = book();
    const wasted: number[] = [];
    let t = 0;
    let open: Stretch | undefined;
    let openAt = 0;
    let due: number | undefined;
    const chats = ["c1", "t1", "t2"];
    for (let n = 0; n < 10_000; n++) {
      // Time only moves forward: nothing happens before the last hand-over.
      t = Math.max(t, openAt) + random() * at(20);
      if (open && random() < 0.7) {
        const spoke = random() < 0.2;
        // Counted when its tokens were taken: at hand-over.
        if (!spoke && open.lane === "fast") wasted.push(openAt);
        if (spoke) b.spoke(open.chatId, "c1", [...open.heard], t);
        b.settle(open, spoke, t);
        open = undefined;
      }
      const chat = chats[Math.floor(random() * chats.length)] as string;
      const plan = say(b, `p${Math.floor(random() * 12)}`, t, { chat, named: random() < 0.3, tier: "balanced" });
      due = plan.dueAt;
      // A timer already past fires now, as setTimeout would.
      due = Math.max(due, t);
      if (!open && due <= t + at(20)) {
        const r = b.handOver(chat, due);
        if (r && "stretch" in r) {
          open = r.stretch;
          openAt = due;
        }
      }
    }
    // In any window of length T: at most cap + T / refill wasted fast stretches.
    for (let i = 0; i < wasted.length; i++) {
      for (let j = i; j < wasted.length; j++) {
        const span = (wasted[j] as number) - (wasted[i] as number);
        expect(j - i + 1).toBeLessThanOrEqual(tier.cap + span / tier.refillMs + 1e-9);
      }
    }
    expect(wasted.length).toBeGreaterThan(10);
  });

  it("backs off a chat whose slow stretches go unanswered, and an answer brings the gap back", () => {
    const b = book();
    for (let n = 0; n < 4; n++) {
      say(b, "u1", at(n * 1000));
      b.settle(handOver(b, at(n * 1000 + 20)), false, at(n * 1000 + 30));
    }
    // Four in a row: past the three that keep the usual gap, doubled twice.
    expect(b.gap("c1")).toBe(8 * 60_000);
    b.spoke("c1", "c1", ["u1"], at(5000));
    expect(b.gap("c1")).toBe(120_000);
    expect(b.gap("c1", 3_600_000)).toBe(3_600_000);
  });

  it("has no fast lane where the agent chose its own pace", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    const plan = b.observe({
      chatId: "c1",
      groupId: "c1",
      senderId: "u1",
      at: at(1),
      now: at(1),
      named: true,
      owner: false,
      tier: "fast",
      everyMs: 3_600_000,
    });
    expect(plan.lane).toBe("slow");
  });

  it("answers the quoted person, or those in a conversation in the stretch it was handed", () => {
    const b = book();
    b.spoke("c1", "c1", ["u1"], 0);
    say(b, "u1", at(1));
    say(b, "u2", at(2));
    handOver(b, at(10));
    expect(b.answered("c1", "u3")).toEqual(["u3"]);
    expect(b.answered("c1", null)).toEqual(["u1"]);
    expect(b.answered("c9", null)).toEqual([]);
  });
});

describe("telling who is meant", () => {
  it("finds a name as a word in Latin script and anywhere in others", () => {
    expect(nameIn("Alex, which way?", ["Alex"])).toBe(true);
    expect(nameIn("alexander said so", ["Alex"])).toBe(false);
    expect(nameIn("小跟班你看下", ["小跟班"])).toBe(true);
    expect(nameIn("hey bot", ["a", null, "bot"])).toBe(true);
    expect(nameIn("x", ["x"])).toBe(false);
  });

  it("counts a question to you, or a line just after the agent spoke, as a cue", () => {
    expect(cueIn("你觉得呢", { at: 0, quotes: false })).toBe(true);
    expect(cueIn("can you check?", { at: 0, quotes: false })).toBe(true);
    expect(cueIn("lunch at 12", { at: 0, quotes: false })).toBe(false);
    expect(cueIn("thanks", { at: 30_000, agentSpokeAt: 0, quotes: false })).toBe(true);
    expect(cueIn("thanks", { at: 30_000, agentSpokeAt: 0, quotes: true })).toBe(false);
  });

  it("picks the fast tier for small groups and groups it knows nothing about", () => {
    expect(defaultTier(undefined)).toBe("fast");
    expect(defaultTier(5)).toBe("fast");
    expect(defaultTier(6)).toBe("balanced");
  });
});
