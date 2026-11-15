import { existsSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type Rig, rig } from "./helpers.ts";

/** An agent's picture in the console (docs/spec.md 8.1). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7]);

async function upload(r: Rig, body: Uint8Array, type = "image/png") {
  const response = await fetch(`${r.url}/v1/admin/agents/${r.agentId}/avatar`, {
    method: "PUT",
    headers: { authorization: `Bearer ${r.mingle.adminToken}`, "content-type": type },
    body: Buffer.from(body),
  });
  return { status: response.status, json: (await response.json()) as { avatar?: string | null; error?: string } };
}

describe("agent avatars", () => {
  it("stores a picture beside the home, serves it by an unguessable URL, and replaces it", async () => {
    current = await rig(async () => {});
    const r = current;
    const first = await upload(r, PNG);
    expect(first.status).toBe(200);
    const url = first.json.avatar as string;
    expect(url).toMatch(new RegExp(`^/v1/avatars/${r.agentId}-[\\w-]{12}\\.png$`));

    // An <img> cannot send the admin token, so the picture needs none; other sites may not embed it.
    const served = await fetch(`${r.url}${url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // Nothing is written into the agent's home.
    const home = r.mingle.homeDir(r.mingle.agent(r.agentId));
    expect(readdirSync(home).some((f) => /\.(png|jpg|webp)$/.test(f))).toBe(false);

    // A new picture gets a new URL; the old one stops working and its file is gone.
    const second = await upload(r, JPEG, "image/jpeg");
    expect(second.json.avatar).toMatch(/\.jpg$/);
    expect((await fetch(`${r.url}${url}`)).status).toBe(404);
    expect(readdirSync(r.mingle.options.paths.avatars)).toHaveLength(1);
    expect(
      ((await r.admin("GET", "/v1/admin/status")).json as { agents: { avatar: string }[] }).agents[0]?.avatar,
    ).toBe(second.json.avatar);

    const cleared = await r.admin("DELETE", `/v1/admin/agents/${r.agentId}/avatar`);
    expect((cleared.json as { avatar: string | null }).avatar).toBeNull();
    expect(readdirSync(r.mingle.options.paths.avatars)).toHaveLength(0);
  });

  it("judges the file by its bytes and refuses anything else", async () => {
    current = await rig(async () => {});
    const r = current;
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    expect(await upload(r, svg, "image/png")).toMatchObject({ status: 400, json: { error: "avatar_invalid" } });
    const huge = new Uint8Array(2 * 1024 * 1024 + 1);
    huge.set(PNG);
    expect(await upload(r, huge)).toMatchObject({ status: 413, json: { error: "avatar_too_large" } });
    expect(r.mingle.agent(r.agentId).avatar).toBeNull();
    // Only a current picture's name is served, never another path.
    expect((await fetch(`${r.url}/v1/avatars/..%2Fmingle.db`)).status).toBe(404);
    expect((await fetch(`${r.url}/v1/avatars/x.png`)).status).toBe(404);
  });

  it("removes the picture with the agent", async () => {
    current = await rig(async () => {});
    const r = current;
    await upload(r, PNG);
    const file = r.mingle.agent(r.agentId).avatar as string;
    const path = `${r.mingle.options.paths.avatars}/${file}`;
    expect(existsSync(path)).toBe(true);
    await r.admin("DELETE", `/v1/admin/agents/${r.agentId}`);
    expect(existsSync(path)).toBe(false);
  });
});
