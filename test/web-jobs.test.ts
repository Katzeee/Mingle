import { describe, expect, it } from "vitest";
import { ApiError, type Job } from "../web/src/api.ts";
import { followJob } from "../web/src/jobs.ts";
import { until } from "./helpers.ts";

const job = (state: Job["state"], detail?: string): Job => ({
  id: "j1",
  kind: "upgrade",
  harness: "kimi",
  state,
  events: [],
  ...(detail ? { detail } : {}),
});
const notFound = () => new ApiError("job_not_found", "start the install, update or sign-in again", 404);

function follow(start: () => Promise<Job>, read: (id: string) => Promise<Job>) {
  const seen: (Job | null)[] = [];
  const ended: (Job | null)[] = [];
  const stop = followJob(
    start,
    read,
    (j) => seen.push(j),
    (j) => ended.push(j),
    1,
  );
  return { seen, ended, stop };
}

describe("following a console job", () => {
  // A console left open for hours resumes an update its cached catalog still shows running.
  it("drops a resumed job Mingle no longer has instead of reporting a failure", async () => {
    const f = follow(
      () => Promise.reject(notFound()),
      () => Promise.reject(notFound()),
    );
    await until(() => f.ended.length > 0);
    expect(f.seen).toEqual([null]);
    expect(f.ended).toEqual([null]);
  });

  it("drops a job that disappears while followed", async () => {
    const f = follow(
      async () => job("running"),
      () => Promise.reject(notFound()),
    );
    await until(() => f.ended.length > 0);
    expect(f.seen.at(-1)).toBeNull();
    expect(f.ended).toEqual([null]);
  });

  it("keeps following through a read that fails for another reason", async () => {
    let reads = 0;
    const f = follow(
      async () => job("running"),
      async () => {
        reads++;
        if (reads === 1) throw new ApiError("offline", "", 0);
        return job(reads < 3 ? "running" : "done");
      },
    );
    await until(() => f.ended.length > 0);
    expect(f.ended).toEqual([job("done")]);
  });

  it("reports a job that could not start as failed", async () => {
    const f = follow(
      () => Promise.reject(new ApiError("unsupported", "this Mingle cannot update harnesses", 400)),
      () => Promise.reject(notFound()),
    );
    await until(() => f.seen.length > 0);
    expect(f.seen[0]).toMatchObject({ state: "failed", detail: "this Mingle cannot update harnesses" });
    expect(f.ended).toEqual([]);
    f.stop();
  });
});
