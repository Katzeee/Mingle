import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANDOFF_MAX_BYTES, handoffPrompt } from "../src/core/handoff.ts";
import { CLI_ENTRY, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Handing an agent what another conversation knows (docs/spec.md 4.12). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NOTES = "## Weekend routes\n- Xiangshan north loop is the favourite\n- Files: ~/hiking/routes";

type HandoffView = { id: string; body: string; via: string; state: string; size: number };

/** The owner's CLI, run outside any agent session, against the rig's Mingle. */
function ownerCli(r: Rig, args: string[], stdin: string, env: Record<string, string> = {}) {
  writeFileSync(join(r.home, "runtime.json"), JSON.stringify({ url: r.url, adminToken: r.mingle.adminToken }));
  const clean = { ...process.env };
  delete clean.MINGLE_TOKEN;
  delete clean.MINGLE_API;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { env: { ...clean, MINGLE_HOME: r.home, ...env } },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(stdin);
  });
}

describe("handoffs", () => {
  it("reaches an idle agent as an input of its own, once, and the console lists it", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { mingle, agentId, admin, channel } = current;
    const sent = await admin("POST", `/v1/admin/agents/${agentId}/handoffs`, { body: `  ${NOTES}\n`, via: "paste" });
    expect(sent.status).toBe(200);
    const { handoff, name, state } = sent.json as { handoff: HandoffView; name: string; state: string };
    expect({ name, state, via: handoff.via, body: handoff.body }).toEqual({
      name: "Alex",
      state: "idle",
      via: "paste",
      body: NOTES,
    });
    expect(handoff.size).toBe(Buffer.byteLength(NOTES));

    await until(() => current?.turns.length === 1);
    const input = current.turns[0]?.input ?? "";
    expect(input).toMatch(
      new RegExp(`^\\[handoff=${handoff.id} from=owner via=paste time=\\S+\\]\\n## Weekend routes`),
    );
    await until(() => mingle.store.handoff(handoff.id)?.state === "delivered");
    const listed = (await admin("GET", `/v1/admin/agents/${agentId}/handoffs`)).json as HandoffView[];
    expect(listed.map((h) => [h.id, h.state])).toEqual([[handoff.id, "delivered"]]);

    // Not delivered again with the next message.
    channel.receive({ text: "hi", chat: dm });
    await until(() => current?.turns.length === 2);
    expect(current.turns[1]?.input).not.toContain("[handoff=");
  });

  it("waits for a busy agent's turn to end instead of steering into it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    current = await rig(async (t) => {
      if (t.input.includes("hi")) await gate;
    });
    const { agentId, admin, channel } = current;
    channel.receive({ text: "hi", chat: dm });
    await until(() => current?.turns.length === 1);
    const { state } = (await admin("POST", `/v1/admin/agents/${agentId}/handoffs`, { body: NOTES })).json as {
      state: string;
    };
    expect(state).toBe("busy");
    await sleep(300);
    expect(current.turns[0]?.steered.join("\n") ?? "").not.toContain("[handoff=");
    release();
    await until(() => current?.turns.length === 2);
    expect(current.turns[1]?.input).toContain("[handoff=");
    expect(current.turns[1]?.input).toContain("via=command");
  });

  it("is kept while the agent is paused and delivered on resume; a reset does not deliver it again", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, admin } = current;
    await admin("POST", `/v1/admin/agents/${agentId}/pause`);
    const { handoff, state } = (await admin("POST", `/v1/admin/agents/${agentId}/handoffs`, { body: NOTES })).json as {
      handoff: HandoffView;
      state: string;
    };
    expect(state).toBe("paused");
    await sleep(300);
    expect(current.turns).toHaveLength(0);
    expect(mingle.store.handoff(handoff.id)?.state).toBe("waiting");

    await admin("POST", `/v1/admin/agents/${agentId}/resume`);
    await until(() => mingle.store.handoff(handoff.id)?.state === "delivered");
    // Delivered means the harness took the input; its turn may start a moment later.
    await until(() => current?.turns.some((t) => t.input.includes(`[handoff=${handoff.id}`)) === true);
    expect(current.turns.filter((t) => t.input.includes(`[handoff=${handoff.id}`))).toHaveLength(1);

    await admin("POST", `/v1/admin/agents/${agentId}/reset`);
    current.channel.receive({ text: "hello", chat: dm });
    await until(() => current?.turns.some((t) => t.input.includes("hello")));
    expect(current.turns.filter((t) => t.input.includes("[handoff="))).toHaveLength(1);
  });

  it("refuses an empty handoff and one over the limit", async () => {
    current = await rig(async () => {});
    const { agentId, admin } = current;
    const empty = await admin("POST", `/v1/admin/agents/${agentId}/handoffs`, { body: "  \n" });
    expect(empty.status).toBe(400);
    expect((empty.json as { error: string }).error).toBe("handoff_empty");
    const large = await admin("POST", `/v1/admin/agents/${agentId}/handoffs`, {
      body: "x".repeat(HANDOFF_MAX_BYTES + 1),
    });
    expect(large.status).toBe(413);
    expect((large.json as { error: string }).error).toBe("handoff_too_large");
    expect(current.mingle.handoffs(agentId)).toEqual([]);
  });

  it("takes a handoff from the owner's CLI, and refuses one from inside an agent session", async () => {
    current = await rig(async () => {});
    const r = current;
    const ok = await ownerCli(r, ["handoff", "alex"], NOTES);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toMatch(/^Handed off to Alex \(h\w+, 0\.1 KB\)\. Alex (reads it now|is working.*)\.\n$/);
    await until(() => r.mingle.handoffs(r.agentId)[0]?.via === "command");

    const fromAgent = await ownerCli(r, ["handoff", "alex"], NOTES, { MINGLE_TOKEN: "x", MINGLE_API: r.url });
    expect(fromAgent.code).not.toBe(0);
    expect(fromAgent.stderr).toContain("handoff_from_agent");

    const prompt = await ownerCli(r, ["handoff", "prompt", "alex"], "");
    // The command as this system's shell takes it: a heredoc, or a PowerShell here-string on Windows.
    expect(prompt.stdout).toContain(
      process.platform === "win32"
        ? `'@ | & "${r.mingle.cliPath}" handoff alex`
        : `"${r.mingle.cliPath}" handoff alex <<'HANDOFF'`,
    );
    expect(prompt.stdout).toContain('its role: "You help a group of friends plan weekend hikes."');
    expect(r.mingle.handoffs(r.agentId)).toHaveLength(1);
  });
});

describe("handoff prompt", () => {
  it("names the agent and its role's first sentence, and the command for this computer", () => {
    const agent = { name: "Alex", slug: "alex" };
    const text = handoffPrompt(agent, 'Plans "routes".  Second sentence.', "/home/me/.mingle/bin/mingle", "linux");
    expect(text).toContain(`its role: "Plans 'routes'."`);
    expect(text).toContain(`"/home/me/.mingle/bin/mingle" handoff alex <<'HANDOFF'`);
    expect(text).toContain('When it prints "Handed off to Alex", tell the owner.');
    expect(handoffPrompt(agent, "", "/x", "linux")).toContain("People reach Alex through chat apps. Alex has not");
    const windows = handoffPrompt(agent, "", "C:\\Users\\me\\.mingle\\bin\\mingle.cmd", "win32");
    expect(windows).toContain(`'@ | & "C:\\Users\\me\\.mingle\\bin\\mingle.cmd" handoff alex`);
  });
});
