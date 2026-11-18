import { afterEach, describe, expect, it } from "vitest";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/**
 * How a group wakes the agent beyond @-mentions (docs/spec.md 4.2): a group the owner set to hear
 * everything, and threads that are one conversation.
 */
describe("a group that hears everything", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const hearing = { quietMs: 150, maxWaitMs: 2_000, gapMs: 0 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let env: Record<string, string> = {};

  /** The agent answers what is addressed to it; what it only heard, it leaves be unless `speak`. */
  async function setup(options: { speak?: boolean; hearing?: typeof hearing } = {}) {
    current = await rig(
      async (t) => {
        env = t.options.env as Record<string, string>;
        if (t.input.includes("[mingle] Heard in")) {
          if (options.speak) {
            const chat = /Heard in (c\w+)/.exec(t.input)?.[1] as string;
            await runCli(env, ["message", "send", "--to", chat], "I know a shorter route.");
          }
          return;
        }
        for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
      },
      { hearing: options.hearing ?? hearing },
    );
    return current;
  }

  async function groupOf(r: Rig): Promise<string> {
    r.channel.receive({ text: "hi all", addressedToBot: false });
    const chat = await until(() => r.mingle.store.agentChats(r.agentId)[0]);
    return chat.id;
  }

  it("keeps the rest of a group as background by default", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    await sleep(500);
    expect(r.turns).toHaveLength(0);
    const conversations = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as {
      chat: { id: string };
      listen: boolean | null;
    }[];
    expect(conversations.find((c) => c.chat.id === chat)?.listen).toBe(false);
  });

  it("hands over a stretch once the group is quiet, which the agent may leave unanswered", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    expect((await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true })).status).toBe(
      200,
    );
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    r.channel.receive({
      text: "8 is early, 9?",
      addressedToBot: false,
      sender: { id: "u2", name: "Li Si", isBot: false },
    });
    await until(() => r.turns.length === 1);
    const input = r.turns[0]?.input ?? "";
    expect(input).toMatch(/^\[mingle\] Heard in c\w+: 2 messages said there, none addressed to you\./);
    expect(input).toContain("shall we start at 8?");
    expect(input).toContain("8 is early, 9?");
    // Said before the group was set to hear everything: not handed over.
    expect(input).not.toContain("hi all");
    // Nothing to answer: no reminder to reply, nothing for the owner, nothing sent.
    await sleep(500);
    expect(r.turns).toHaveLength(1);
    expect(r.channel.sent).toHaveLength(0);
    expect(r.mingle.store.chatMessages(chat, 10).every((m) => m.state === "ignored")).toBe(true);
    const listed = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as {
      listen: boolean | null;
    }[];
    expect(listed[0]?.listen).toBe(true);
  });

  it("lets the agent speak up, and starts the next stretch after what it said", async () => {
    const r = await setup({ speak: true });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.channel.sent.length === 1);
    expect(r.channel.sent[0]?.text).toBe("I know a shorter route.");
    r.channel.receive({ text: "great, thanks", addressedToBot: false });
    await until(() => r.turns.length === 2);
    expect(r.turns[1]?.input).toContain("great, thanks");
    expect(r.turns[1]?.input).not.toContain("which way to the top?");
  });

  it("does not start a stretch for another bot", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "deploy failed", addressedToBot: false, sender: { id: "b9", name: "Bob", isBot: true } });
    await sleep(500);
    expect(r.turns).toHaveLength(0);
  });

  it("drops the waiting stretch when someone @s the agent meanwhile", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    r.channel.receive({ text: "@alex what do you think?" });
    await until(() => r.turns.length === 1);
    await sleep(500);
    expect(r.turns).toHaveLength(1);
    // The @ came as a message to answer, with what was said before it counted as unseen.
    expect(r.turns[0]?.input).toMatch(/unseen=\d+/);
    expect(r.turns[0]?.input).not.toContain("[mingle] Heard in");
  });

  it("waits out the gap between stretches, and stops when turned off", async () => {
    const r = await setup({ hearing: { quietMs: 100, maxWaitMs: 2_000, gapMs: 1_000 } });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "one", addressedToBot: false });
    await until(() => r.turns.length === 1);
    const first = Date.now();
    r.channel.receive({ text: "two", addressedToBot: false });
    await until(() => r.turns.length === 2);
    expect(Date.now() - first).toBeGreaterThanOrEqual(800);
    expect(r.turns[1]?.input).toContain("two");
    expect(r.turns[1]?.input).not.toContain("one\n");

    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: false });
    r.channel.receive({ text: "three", addressedToBot: false });
    await sleep(1_300);
    expect(r.turns).toHaveLength(2);
  });

  it("is set on groups only", async () => {
    const r = await setup();
    r.channel.receive({ text: "hello", chat: { platformId: "42", kind: "dm" } });
    await until(() => r.turns.length === 1);
    const dm = r.mingle.store.agentChats(r.agentId)[0]?.id as string;
    expect((await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${dm}/listen`, { listen: true })).status).toBe(
      404,
    );
    const group = await groupOf(r);
    expect(
      (await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${group}/listen`, { listen: "yes" })).status,
    ).toBe(400);
  });
});

describe("a thread that is one conversation", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const thread = { platformId: "-100:7", kind: "thread" as const, name: "Saturday", followUp: true as const };

  it("goes on without an @ once the agent has spoken there", async () => {
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const r = current;
    // Before the agent said anything there, the thread is like the rest of the group.
    r.channel.receive({ text: "who is coming?", chat: thread, addressedToBot: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(0);
    r.channel.receive({ text: "@alex can you plan it?", chat: thread });
    await until(() => r.turns.length === 1 && r.channel.sent.length === 1);
    r.channel.receive({ text: "and the weather?", chat: thread, addressedToBot: false });
    // Reaches the agent: as a turn of its own, or steered into the one still finishing.
    const seen = () => r.turns.flatMap((t) => [t.input, ...t.steered]).join("\n");
    await until(() => seen().includes("and the weather?"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const turns = r.turns.length;
    // Another bot still needs an @, whatever the thread.
    r.channel.receive({
      text: "build passed",
      chat: thread,
      addressedToBot: false,
      sender: { id: "b9", name: "Bob", isBot: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(turns);
    expect(seen()).not.toContain("build passed");
  });

  it("does not follow up in a thread that is a lasting place", async () => {
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const r = current;
    const topic = { platformId: "-100:9", kind: "thread" as const, name: "Gear" };
    r.channel.receive({ text: "@alex boots?", chat: topic });
    await until(() => r.turns.length === 1 && r.channel.sent.length === 1);
    r.channel.receive({ text: "I bought mine", chat: topic, addressedToBot: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(1);
  });
});
