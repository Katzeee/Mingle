import { ApiError, type Job } from "./api.ts";

/** Mingle no longer has the job: it finished long ago or Mingle restarted. Its outcome is unknown, not a failure. */
const gone = (error: unknown) => error instanceof ApiError && error.code === "job_not_found";

/**
 * Follow a job from `start` until it ends. `onJob` gets every state, null once the job is gone;
 * `onEnd` gets the outcome, null when it is unknown. A read that fails for another reason (Mingle
 * busy, a dropped request) is tried again: only the job itself decides when following stops.
 * Returns the function that stops following.
 */
export function followJob(
  start: () => Promise<Job>,
  read: (id: string) => Promise<Job>,
  onJob: (job: Job | null) => void,
  onEnd: (job: Job | null) => void,
  everyMs = 1000,
): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (job: Job | null) => {
    onJob(job);
    if (job?.state === "running") timer = setTimeout(() => poll(job.id), everyMs);
    else onEnd(job);
  };
  const poll = (id: string) =>
    read(id).then(
      (job) => live && settle(job),
      (error: unknown) => {
        if (!live) return;
        if (gone(error)) settle(null);
        else timer = setTimeout(() => poll(id), everyMs);
      },
    );
  start().then(
    (first) => {
      if (!live) return;
      onJob(first);
      if (first.state === "running") void poll(first.id);
      else onEnd(first);
    },
    (error: Error) => {
      if (!live) return;
      if (gone(error)) settle(null);
      else onJob({ id: "", kind: "install", harness: "", state: "failed", events: [], detail: error.message });
    },
  );
  return () => {
    live = false;
    clearTimeout(timer);
  };
}
