/**
 * Handing an agent what another conversation knows (docs/spec.md 4.12): the prompt the owner gives
 * that conversation, and the limits of what comes back.
 */
import { MingleError } from "./errors.ts";

/** About 50K tokens: more would crowd the agent's context in one input. */
export const HANDOFF_MAX_BYTES = 200 * 1024;

/** The role's first sentence, enough for the other conversation to know whom it writes for. */
function roleLine(role: string): string {
  const text = role.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = /^.+?[.!?。！？](?=\s|$)/u.exec(text)?.[0] ?? text;
  const chars = [...sentence];
  return chars.length > 200 ? `${chars.slice(0, 200).join("").trimEnd()}…` : sentence;
}

/** The handoff text as it is stored: trimmed, not empty, within the limit. */
export function checkHandoff(body: unknown): string {
  if (typeof body !== "string" || !body.trim()) {
    throw new MingleError("handoff_empty", "write the handoff and pass it on standard input");
  }
  const text = body.trim();
  const size = Buffer.byteLength(text, "utf8");
  if (size > HANDOFF_MAX_BYTES) {
    throw new MingleError(
      "handoff_too_large",
      `this is ${Math.ceil(size / 1024)} KB; the limit is ${HANDOFF_MAX_BYTES / 1024} KB. Write the details to a file and hand off its path instead`,
      413,
    );
  }
  return text;
}

/**
 * What the owner pastes into another conversation (Claude Code, Codex, any agent with a shell on
 * this computer) so it writes a handoff and sends it with `mingle handoff`. English: it is for a
 * model, which writes in the owner's language anyway.
 */
export function handoffPrompt(
  agent: { readonly name: string; readonly slug: string },
  role: string,
  cli: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const line = roleLine(role);
  const who = line
    ? `People reach ${agent.name} through chat apps; its role: "${line.replaceAll('"', "'")}"`
    : `People reach ${agent.name} through chat apps.`;
  const send =
    platform === "win32"
      ? [
          "Send it on standard input, in PowerShell, up to 200 KB:",
          "",
          "```powershell",
          "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
          "@'",
          "(your handoff)",
          `'@ | & "${cli}" handoff ${agent.slug}`,
          "```",
        ]
      : [
          "Send it on standard input, up to 200 KB:",
          "",
          "```bash",
          `"${cli}" handoff ${agent.slug} <<'HANDOFF'`,
          "(your handoff)",
          "HANDOFF",
          "```",
        ];
  return [
    `You are handing work over to ${agent.name}, an agent in Mingle on this computer. ${who} ${agent.name} has not seen this conversation.`,
    "",
    `Write a handoff for ${agent.name} from this conversation, then send it with the command below. Give ${agent.name} what it needs to carry on without you:`,
    "- the background and the goal",
    "- decisions made, and why",
    "- work in progress: what is done, what comes next",
    "- open questions, and anything waiting on someone",
    "- what you learned about the owner's preferences",
    "- paths to the folders, repositories and files involved, and to this conversation's transcript if you know where it is",
    "",
    "Leave out secrets: tokens, passwords, keys. Do not paste the conversation itself; give paths. Write in the language the owner uses with you.",
    "",
    ...send,
    "",
    `When it prints "Handed off to ${agent.name}", tell the owner.`,
    "",
  ].join("\n");
}
