import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** The owner cancels reminders and closes tasks from the console (docs/spec.md 4.6). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("owner changes to tasks and reminders", () => {
  it("cancels a reminder and closes a task, and tells the agent with its next input only", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { channel, mingle, agentId, admin } = current;
    const reminder = mingle.store.createReminder({
      agentId,
      body: "Daily summary",
      rule: "daily@09:00",
      timezone: "UTC",
      chatId: null,
      nextFireAt: Date.now() + 3_600_000,
    });
    const task = mingle.store.createTask({ agentId, title: "Compare the routes", fromMessage: null, fromChat: null });
    const done = mingle.store.createTask({ agentId, title: "Book the hut", fromMessage: null, fromChat: null });
    mingle.store.setTaskStatus(agentId, done.id, "done");

    expect(await admin("DELETE", `/v1/admin/agents/${agentId}/reminders/${reminder.id}`)).toEqual({
      status: 200,
      json: { ok: true },
    });
    expect(await admin("POST", `/v1/admin/agents/${agentId}/tasks/${task.id}/close`)).toEqual({
      status: 200,
      json: { changed: true },
    });
    // Repeats and unknown ids.
    expect((await admin("POST", `/v1/admin/agents/${agentId}/tasks/${task.id}/close`)).json).toEqual({
      changed: false,
    });
    expect((await admin("POST", `/v1/admin/agents/${agentId}/tasks/${done.id}/close`)).json).toEqual({
      changed: false,
    });
    expect(mingle.store.task(agentId, done.id)?.status).toBe("done");
    expect((await admin("DELETE", `/v1/admin/agents/${agentId}/reminders/${reminder.id}`)).status).toBe(404);
    expect((await admin("POST", `/v1/admin/agents/${agentId}/tasks/tnope/close`)).status).toBe(404);

    // The console reads the new state.
    const work = (await admin("GET", `/v1/admin/agents/${agentId}/work`)).json as {
      tasks: unknown[];
      reminders: unknown[];
    };
    expect(work).toEqual({ tasks: [], reminders: [] });
    expect(mingle.store.task(agentId, task.id)?.status).toBe("closed");

    // No turn of its own; the next message carries the notes once.
    await sleep(300);
    expect(current.turns).toHaveLength(0);
    channel.receive({ text: "hi", chat: dm });
    await until(() => channel.sent.some((m) => m.text === "ok"));
    const input = current.turns[0]?.input ?? "";
    expect(input).toContain(
      `[mingle] The owner cancelled reminder ${reminder.id} ("Daily summary") in the console. It will not fire again; don't set it again unless asked.`,
    );
    expect(input).toContain(`[mingle] The owner closed task ${task.id} ("Compare the routes") in the console.`);
    expect(input.indexOf("[mingle] The owner")).toBeLessThan(input.indexOf("hi"));
    expect(mingle.store.ownerNotes(agentId)).toEqual([]);

    channel.receive({ text: "again", chat: dm });
    await until(() => current?.turns.length === 2);
    expect(current.turns[1]?.input).not.toContain("[mingle] The owner");
  });

  it("works while the agent is paused, and the cancelled reminder never fires", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, admin } = current;
    const due = mingle.store.createReminder({
      agentId,
      body: "Check the forecast",
      rule: "once",
      timezone: "UTC",
      chatId: null,
      nextFireAt: Date.now() + 3_600_000,
    });
    const task = mingle.store.createTask({ agentId, title: "Compare the routes", fromMessage: null, fromChat: null });
    mingle.store.setTaskStatus(agentId, task.id, "in_progress");
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);

    expect((await admin("DELETE", `/v1/admin/agents/${agentId}/reminders/${due.id}`)).status).toBe(200);
    expect((await admin("POST", `/v1/admin/agents/${agentId}/tasks/${task.id}/close`)).json).toEqual({
      changed: true,
    });
    expect(mingle.store.reminders(agentId)).toEqual([]);

    await admin("POST", `/v1/admin/agents/${agentId}/resume`);
    mingle.fireReminders(Date.now() + 7_200_000);
    await sleep(1500);
    expect(current.turns.some((t) => t.input.includes("Check the forecast"))).toBe(false);
    // The notes still wait for the next input after the pause.
    expect(mingle.store.ownerNotes(agentId)).toHaveLength(2);
  });
});

describe("owner notes in the store", () => {
  it("keeps notes per agent in order until told, and drops them with the agent", () => {
    const store = new Store(":memory:");
    const alex = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const sam = store.createAgent({ name: "Sam", slug: "sam", harness: "scripted" });
    store.addOwnerNote(alex.id, "first");
    store.addOwnerNote(alex.id, "second");
    store.addOwnerNote(sam.id, "other");
    const notes = store.ownerNotes(alex.id);
    expect(notes.map((n) => n.body)).toEqual(["first", "second"]);
    // Only the ones told are removed, and only the agent's own.
    store.addOwnerNote(alex.id, "third");
    store.deleteOwnerNotes(
      sam.id,
      notes.map((n) => n.id),
    );
    store.deleteOwnerNotes(
      alex.id,
      notes.map((n) => n.id),
    );
    expect(store.ownerNotes(alex.id).map((n) => n.body)).toEqual(["third"]);
    expect(store.ownerNotes(sam.id).map((n) => n.body)).toEqual(["other"]);
    store.deleteAgent(alex.id);
    expect(store.ownerNotes(alex.id)).toEqual([]);
    store.close();
  });
});
