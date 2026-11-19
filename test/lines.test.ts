import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LINES } from "../src/core/lines.ts";
import { renderManual } from "../src/core/manual.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Several things at once (docs/spec.md 4.13): lines beside the main session. */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const env = (t: ScriptedTurn) => t.options.env as Record<string, string>;
const isLine = (t: ScriptedTurn) => String(t.options.cwd).includes("/lines/");
/** The message a line's brief says it is for. */
const fromOf = (input: string) => input.match(/\[task=t\w+ from=(m\w+)/)?.[1] as string;
const taskOf = (input: string) => input.match(/\[task=(t\w+)/)?.[1] as string;

describe("lines", () => {
  it("works on a long task beside the main session, answers in the chat, and takes follow-ups", async () => {
    const front: string[] = [];
    const line: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let task = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        line.push(t.input);
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          // Busy for a while: the main session must stay free meanwhile.
          await gate;
          await runCli(env(t), ["message", "reply", fromOf(t.input)], "Fixed: PR #12.");
          await runCli(env(t), ["task", "done", task], "Fixed the token refresh. PR #12. Learned: run pnpm test:web.");
        } else {
          const id = messageIds(t.input)[0] as string;
          await runCli(env(t), ["message", "reply", id], "Signup is fixed too.");
        }
        return;
      }
      front.push(t.input);
      for (const id of messageIds(t.input)) {
        if (t.input.includes("Fix the login")) {
          await runCli(env(t), ["task", "run", "Fix the login", "--from", id], "Safari only. Open a PR.");
          await runCli(env(t), ["message", "reply", id], "On it.");
        } else await runCli(env(t), ["message", "reply", id], "10:30.");
      }
    });
    const { mingle, channel, agentId } = current;

    channel.receive({ text: "@Alex Fix the login on Safari" });
    await until(() => task && channel.sent.some((m) => m.text === "On it.") && !mingle.runtime(agentId)?.busy);
    // While the line works, the main session answers something else at once.
    channel.receive({ text: "@Alex when is the meeting?" });
    await until(() => channel.sent.some((m) => m.text === "10:30."));
    expect(line).toHaveLength(1);
    release();

    // The line answers under the message it came from, as the agent.
    await until(() => channel.sent.some((m) => m.text === "Fixed: PR #12."));
    const fixed = channel.sent.find((m) => m.text === "Fixed: PR #12.");
    const asked = channel.sent.find((m) => m.text === "On it.");
    expect(fixed?.replyTo).toBe(asked?.replyTo);
    await until(() => mingle.store.task(agentId, task)?.status === "done");
    expect(line[0]).toContain("Safari only. Open a PR.");

    // A reply to the line's answer goes to the line, not the main session.
    channel.receive({ text: "Can you look at signup too?", replyTo: fixed?.platformId as string });
    await until(() => channel.sent.some((m) => m.text === "Signup is fixed too."));
    expect(line.at(-1)).toContain("Can you look at signup too?");
    expect(front.join("\n")).not.toContain("Can you look at signup too?");
    expect(mingle.store.task(agentId, task)?.status).toBe("in_progress");

    // The summary reaches the main session with its next input, not as a turn of its own.
    const turns = front.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(front).toHaveLength(turns);
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({ text: "@Alex thanks" });
    await until(() => front.length > turns);
    expect(front.at(-1)).toContain("Learned: run pnpm test:web.");
    // Nothing was left unanswered or nudged.
    expect(front.join("\n")).not.toContain("Not answered yet");
  });

  it("keeps a line to its task, and only lines finish tasks", async () => {
    let lineEnv: Record<string, string> | undefined;
    let frontEnv: Record<string, string> | undefined;
    current = await rig(async (t) => {
      if (isLine(t)) {
        lineEnv = env(t);
        return;
      }
      frontEnv = env(t);
      const id = messageIds(t.input)[0];
      if (id && t.input.includes("work")) await runCli(env(t), ["task", "run", "Work", "--from", id], "Do it.");
    });
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex some work", chat: { platformId: "-200", kind: "group", name: "Other" } });
    const asLine = await until(() => lineEnv);
    const asFront = await until(() => frontEnv);
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({ text: "@Alex hello" });
    const elsewhere = await until(
      () =>
        mingle.store.agentConversations(agentId, { chats: 5, messages: 5 }).find((c) => c.chat.name === "Weekend hikes")
          ?.messages[0]?.id,
    );

    const reply = await runCli(asLine, ["message", "reply", elsewhere], "hi");
    expect(reply.code).not.toBe(0);
    expect(reply.stderr + reply.stdout).toContain("line_out_of_scope");
    const remind = await runCli(asLine, ["reminder", "set", "x", "--in", "1h", "--chat", "c1"]);
    expect(remind.stderr + remind.stdout).toContain("line_out_of_scope");
    const nested = await runCli(asLine, ["task", "run", "More", "--from", elsewhere], "x");
    expect(nested.stderr + nested.stdout).toContain("line_out_of_scope");
    const me = await runCli(asLine, ["whoami"]);
    expect(me.stdout).toContain("this session works on t");
    const done = await runCli(asFront, ["task", "done", "t1"], "x");
    expect(done.stderr + done.stdout).toContain("line_only");
  });

  it("runs at most three lines at once and starts the next when one is free", async () => {
    const gates: (() => void)[] = [];
    let running = 0;
    let most = 0;
    current = await rig(async (t) => {
      if (isLine(t)) {
        running++;
        most = Math.max(most, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
        await runCli(env(t), ["task", "done", taskOf(t.input)], "done");
        return;
      }
      for (const id of messageIds(t.input)) await runCli(env(t), ["task", "run", `Job ${id}`, "--from", id], "go");
    });
    const { channel, mingle, agentId } = current;
    for (let i = 0; i < MAX_LINES + 1; i++) {
      channel.receive({ text: `@Alex job ${i}`, chat: { platformId: `-3${i}`, kind: "group", name: `G${i}` } });
    }
    await until(() => gates.length === MAX_LINES);
    await new Promise((r) => setTimeout(r, 200));
    expect(gates).toHaveLength(MAX_LINES);
    expect(mingle.store.activeLines(agentId).filter((t) => t.lineState === "queued")).toHaveLength(1);
    gates.shift()?.();
    await until(() => gates.length === MAX_LINES);
    // The fourth started once one finished; let the rest go.
    expect(mingle.store.activeLines(agentId).filter((t) => t.lineState === "queued")).toHaveLength(0);
    for (const open of gates.splice(0)) open();
    await until(() => mingle.store.activeLines(agentId).length === 0);
    expect(most).toBe(MAX_LINES);
  });

  it("stops every line with /stop, one from the console, and carries on after a restart", async () => {
    let started = 0;
    current = await rig(async (t) => {
      if (isLine(t)) {
        started++;
        await new Promise(() => {}); // works until stopped
        return;
      }
      const id = messageIds(t.input)[0];
      if (id && t.input.includes("job")) await runCli(env(t), ["task", "run", "Job", "--from", id], "go");
    });
    const { channel, mingle, agentId, admin } = current;
    channel.receive({ text: "@Alex job" });
    await until(() => started === 1);
    const task = mingle.store.activeLines(agentId)[0]?.id as string;
    expect(await mingle.stopAgent(agentId)).toBe(true);
    await until(() => mingle.store.task(agentId, task)?.lineState === "idle");
    // Still in progress: the next message about it wakes it again.
    expect(mingle.store.task(agentId, task)?.status).toBe("in_progress");

    mingle.lines.wake(task, "go on");
    await until(() => started === 2);
    // Work under way when Mingle stops (here: its sessions let go) carries on when it starts again.
    await mingle.lines.suspend(agentId);
    expect(mingle.store.task(agentId, task)?.lineState).toBe("running");
    mingle.lines.restore(agentId);
    await until(() => started === 3);
    await admin("POST", `/v1/admin/agents/${agentId}/tasks/${task}/close`);
    await until(() => mingle.store.task(agentId, task)?.lineState === "ended");
    expect(mingle.store.task(agentId, task)?.status).toBe("closed");
  });

  it("guides the main session to hand off long work, and a line to stay on its task", () => {
    const main = renderManual("Alex", "", "darwin");
    expect(main).toContain("## Doing long work");
    expect(main).toContain("task run");
    const line = renderManual("Alex", "", "darwin", [], { taskId: "t9", title: "Fix login", home: "/h/alex" });
    expect(line).toContain('works on one task: t9, "Fix login"');
    expect(line).toContain("task done t9");
    expect(line).toContain("You are still Alex");
  });
});
