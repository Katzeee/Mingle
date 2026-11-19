import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { renderManual } from "../src/core/manual.ts";
import { Mingle } from "../src/core/mingle.ts";
import { MAX_TEAM_HOPS, TeamHops } from "../src/core/team.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Teams (docs/spec.md 4.13): a lead and its members, and the direct chat each pair shares. */

let current: (Rig & { inputs: Record<string, string[]> }) | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

type Turn = (t: ScriptedTurn) => Promise<void>;
const env = (t: ScriptedTurn) => t.options.env as Record<string, string>;
const who = (t: ScriptedTurn) => basename(String(t.options.cwd));

/** A rig whose turns go to a script per agent, by its home directory's name. */
async function team(scripts: Record<string, Turn>): Promise<Rig & { inputs: Record<string, string[]> }> {
  const inputs: Record<string, string[]> = {};
  const r = await rig(async (t) => {
    const name = who(t);
    inputs[name] = [...(inputs[name] ?? []), t.input];
    await scripts[name]?.(t);
  });
  return Object.assign(r, { inputs });
}

const coder = (r: Rig) =>
  r.mingle.createAgent({ name: "Coder", role: "You write code.\nKeep it tidy.", harness: "scripted" });

describe("forming a team", () => {
  it("lets the owner add and remove members, one level and one team each", async () => {
    current = await team({});
    const { mingle, admin, agentId } = current;
    const c = coder(current);
    const lily = mingle.createAgent({ name: "Lily", role: "", harness: "scripted" });

    const added = await admin("POST", `/v1/admin/agents/${agentId}/members`, { member: c.id });
    expect(added.status).toBe(200);
    expect((added.json as { leadId: string }).leadId).toBe(agentId);
    expect(mingle.store.members(agentId).map((m) => m.name)).toEqual(["Coder"]);

    const refused = async (lead: string, member: string) =>
      ((await admin("POST", `/v1/admin/agents/${lead}/members`, { member })).json as { error: string }).error;
    expect(await refused(agentId, agentId)).toBe("team_self");
    expect(await refused(c.id, lily.id)).toBe("team_lead_is_member");
    expect(await refused(lily.id, agentId)).toBe("team_member_leads");
    expect(await refused(lily.id, c.id)).toBe("team_member_taken");

    // The agents list carries the relation, for the console's tree.
    const list = (
      (await admin("GET", "/v1/admin/status")).json as { agents: { name: string; leadId: string | null }[] }
    ).agents;
    expect(list.find((a) => a.name === "Coder")?.leadId).toBe(agentId);

    expect((await admin("DELETE", `/v1/admin/agents/${agentId}/members/${c.id}`)).status).toBe(200);
    expect(mingle.agent(c.id).leadId).toBeNull();
    // Both hear it with their next input, without a turn of their own.
    expect(
      mingle.store
        .ownerNotes(c.id)
        .map((n) => n.body)
        .join("\n"),
    ).toContain("took you out of Alex's team");
  });

  it("creates a new agent straight into a team, and frees members when the lead is deleted", async () => {
    current = await team({});
    const { mingle, admin, agentId } = current;
    const made = await admin("POST", "/v1/admin/agents", { name: "Designer", harness: "scripted", lead: agentId });
    expect(made.status).toBe(200);
    const designer = made.json as { id: string; leadId: string };
    expect(designer.leadId).toBe(agentId);

    await mingle.deleteAgent(agentId, true);
    expect(mingle.agent(designer.id).leadId).toBeNull();
    expect(mingle.store.teamConnection(agentId)).toBeUndefined();
  });

  it("writes the team into each agent's guide", () => {
    const lead = renderManual("Alex", "", "darwin", [], { role: "lead", members: ["Coder", "Researcher"] });
    // No names in the guide: who is in the team changes without a new session, so whoami says it.
    expect(lead).toContain("You lead a team of agents on this computer.");
    expect(lead).not.toContain("Researcher");
    expect(lead).toContain("task create");
    expect(lead).toContain("--to <member>");
    expect(lead).toContain("starts on it once that is done");
    const member = renderManual("Coder", "", "darwin", [], { role: "member", lead: "Alex" });
    expect(member).toContain("You are in Alex's team.");
    expect(member).toContain("finish what you are doing first");
    expect(renderManual("Kit", "", "darwin")).not.toContain("## Your team");
  });
});

describe("working as a team", () => {
  it("hands work to a member and reports back in the person's chat, with nothing left unanswered", async () => {
    let task = "";
    current = await team({
      alex: async (t) => {
        const ids = messageIds(t.input);
        if (t.input.includes("im=telegram") && t.input.includes("Fix the login")) {
          const id = ids[0] as string;
          const made = await runCli(
            env(t),
            ["task", "create", "Fix the login", "--to", "Coder", "--from", id],
            "Safari only.",
          );
          task = made.stdout.match(/created (t\w+)/)?.[1] ?? "";
          await runCli(env(t), ["message", "reply", id], "On it: Coder is taking this.");
        } else if (t.input.includes("im=team")) {
          // The member's report: answer the person, quoting what they asked.
          const asked = current?.mingle.store.tasks(current.agentId, true)[0]?.fromMessage as string;
          await runCli(env(t), ["message", "reply", asked], "Fixed: PR #12.");
        }
      },
      coder: async (t) => {
        const id = messageIds(t.input)[0] as string;
        await runCli(env(t), ["message", "reply", id], "Done, PR #12.");
        await runCli(env(t), ["task", "update", task, "--status", "done"]);
      },
    });
    const { mingle, channel, agentId, inputs } = current;
    const c = coder(current);
    await mingle.addMember(agentId, c.id);

    channel.receive({ text: "@Alex Fix the login on Safari" });
    await until(() => channel.sent.some((m) => m.text === "Fixed: PR #12."), 15_000);

    // The member got the brief in its team chat, from the lead.
    const brief = inputs.coder?.find((i) => i.includes("Task t")) ?? "";
    expect(brief).toContain("im=team");
    expect(brief).toContain('from="Alex"');
    expect(brief).toContain("Safari only.");
    expect(channel.sent.map((m) => m.text)).toEqual(["On it: Coder is taking this.", "Fixed: PR #12."]);
    // The team chat never asks anyone to answer, and the person's message ends answered.
    expect(Object.values(inputs).flat().join("\n")).not.toContain("Not answered yet");
    expect(mingle.store.tasks(agentId, true)[0]).toMatchObject({ status: "done", assigneeId: c.id });
    expect(mingle.store.awaitingReply(c.id)).toEqual([]);
    expect(mingle.store.heldMessages(agentId)).toEqual([]);
  });

  it("shows the team in whoami and refuses to write to a paused or former member", async () => {
    let cli: Record<string, string> | undefined;
    current = await team({
      alex: async (t) => {
        cli = env(t);
        const id = messageIds(t.input)[0];
        if (id) await runCli(env(t), ["message", "reply", id], "hi");
      },
    });
    const { mingle, agentId, channel } = current;
    const c = coder(current);
    await mingle.addMember(agentId, c.id);
    // Alex's CLI environment, as its session has it.
    channel.receive({ text: "@Alex hello" });
    const as = await until(() => cli);
    const me = await runCli(as, ["whoami"]);
    expect(me.stdout).toContain("team: you lead");
    expect(me.stdout).toMatch(/Coder \(u\w+\)/);
    expect(me.stdout).toContain("You write code.");

    await mingle.pauseAgent(c.id);
    const paused = await runCli(as, ["task", "create", "Anything", "--to", "Coder"], "brief");
    expect(paused.code).not.toBe(0);
    expect(paused.stderr + paused.stdout).toContain("paused");
    await mingle.resumeAgent(c.id);

    const contact = me.stdout.match(/Coder \((u\w+)\)/)?.[1] as string;
    await mingle.removeMember(agentId, c.id);
    const gone = await runCli(as, ["message", "send", "--to", contact], "hello");
    expect(gone.code).not.toBe(0);
    expect(gone.stderr + gone.stdout).toContain("no longer in your team");
  });

  it("stops two agents that keep answering each other, until the owner lets them go on", async () => {
    const said: string[] = [];
    const chatty: Turn = async (t) => {
      for (const id of messageIds(t.input)) said.push((await runCli(env(t), ["message", "reply", id], "ok")).stdout);
    };
    current = await team({
      alex: async (t) => {
        if (t.input.includes("im=telegram")) {
          await runCli(env(t), ["task", "create", "Ping", "--to", "Coder"], "go");
          return;
        }
        await chatty(t);
      },
      coder: chatty,
    });
    const { mingle, agentId, admin, channel } = current;
    const c = coder(current);
    await mingle.addMember(agentId, c.id);
    channel.receive({ text: "@Alex start" });

    await until(() => mingle.teamStops(agentId).length === 1, 30_000);
    const view = (await admin("GET", `/v1/admin/agents/${agentId}`)).json as { teamStops: { name: string }[] };
    expect(view.teamStops[0]?.name).toBe("Coder");
    // Stopped messages wait for the owner; they are not offered as strangers to let in.
    expect(mingle.store.heldMessages(agentId)).toEqual([]);
    expect(mingle.store.heldMessages(c.id)).toEqual([]);
    // The one whose message was held hears so, instead of waiting for an answer.
    await until(() => said.some((o) => o.includes("stopped this team chat")));

    // A restart forgets the counts, not the stop: the held message still waits for the owner.
    const again = new Mingle(mingle.options);
    await again.start("http://127.0.0.1:1");
    try {
      expect(again.teamStops(agentId).map((s) => s.name)).toEqual(["Coder"]);
      expect(again.teamStops(c.id).map((s) => s.name)).toEqual(["Alex"]);
    } finally {
      await again.stop();
    }

    await mingle.removeMember(agentId, c.id); // ends the exchange before letting it go on
    await mingle.addMember(agentId, c.id);
    const released = (await admin("POST", `/v1/admin/agents/${agentId}/team/continue`, { with: c.id })).json as {
      released: number;
    };
    expect(released.released).toBe(1);
    expect(mingle.teamStops(agentId)).toEqual([]);
    await mingle.removeMember(agentId, c.id);
  });
});

describe("files in a team chat", () => {
  it("hands over a copy, so the sender may change or delete its own", async () => {
    let sent = false;
    current = await team({
      alex: async (t) => {
        if (sent || !t.input.includes("im=telegram")) return;
        sent = true;
        const file = join(String(t.options.cwd), "notes.txt");
        writeFileSync(file, "first");
        const contact = (await runCli(env(t), ["whoami"])).stdout.match(/Coder \((u\w+)\)/)?.[1] as string;
        await runCli(env(t), ["message", "send", "--to", contact, "--file", file], "the notes");
        rmSync(file);
      },
    });
    const { mingle, agentId, channel } = current;
    const c = coder(current);
    await mingle.addMember(agentId, c.id);
    channel.receive({ text: "@Alex go" });
    const connection = mingle.store.teamConnection(c.id);
    const chat = await until(() => connection && mingle.store.directChat(connection.id, agentId));
    const withFile = await until(() =>
      mingle.store.chatMessages(chat.id, 20).find((m) => m.direction === "in" && m.attachments.length > 0),
    );
    const ref = withFile.attachments[0]?.ref as string;
    expect(ref.startsWith(join(current.home, "team-files"))).toBe(true);
    expect(readFileSync(ref, "utf8")).toBe("first");
  });
});

describe("TeamHops", () => {
  it("stops a pair after the limit, and a person gives it its turns back", () => {
    const hops = new TeamHops();
    for (let i = 0; i < MAX_TEAM_HOPS; i++) expect(hops.woke("a", "b", 1)).toBe(false);
    expect(hops.woke("b", "a", 2)).toBe(true);
    expect(hops.stoppedAt("a", "b")).toBe(2);
    hops.person("a"); // a stopped pair waits for the owner
    expect(hops.stoppedAt("a", "b")).toBe(2);
    hops.release("a", "b");
    expect(hops.woke("a", "b")).toBe(false);
    hops.person("b");
    for (let i = 0; i < MAX_TEAM_HOPS; i++) expect(hops.woke("a", "b")).toBe(false);
  });
});
