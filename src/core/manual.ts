import { readFileSync } from "node:fs";

const TEMPLATE = new URL("../cli/manual.md", import.meta.url);

/**
 * On Windows a harness may run commands in PowerShell, where `"$MINGLE_CLI"` and heredocs
 * mean nothing. Only Windows agents read this.
 */
const POWERSHELL = `
## If your shell is PowerShell

The examples are bash. In PowerShell, run the CLI with \`& $env:MINGLE_CLI\` and pipe the body in as a here-string, after setting UTF-8 so non-English text survives:

\`\`\`powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
@'
Saturday looks clear.
'@ | & $env:MINGLE_CLI message reply m8f2a
\`\`\`
`;

/**
 * The names of the variables the owner set for this agent. Never their values: the guide goes into
 * the transcript and to the model's provider.
 */
function envSection(names: readonly string[], platform: NodeJS.Platform): string {
  const read = platform === "win32" ? "`$env:NAME` in PowerShell, `$NAME` in bash" : "`$NAME`";
  return `
## Environment variables set for you

Your owner set these for you: ${names.map((n) => `\`${n}\``).join(", ")}. Read them in your shell as ${read}. They hold secrets such as webhook addresses and API keys: use them in commands, and do not write their values into messages, files or notes.
`;
}

/** Who the agent works with, for its guide (docs/spec.md 4.13). */
export type TeamRole = { role: "lead"; members: readonly string[] } | { role: "member"; lead: string };

const list = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The lead's part: stay with the people, hand the long work to the team. */
function leadSection(members: readonly string[]): string {
  const one = members[0] ?? "Coder";
  return `
## Your team

You lead a team: ${list(members)}. Each is an agent on this computer with its own role, memory and session. You and each member share a direct chat nobody else sees; its messages carry \`im=team\`.

**Your job is the conversation with people, so stay responsive.** A turn of yours should end within a minute or two; while you work on something long, everyone else waits.

- Answer yourself what takes a minute or two: questions, quick lookups, short replies.
- Hand off anything longer: writing or changing code, research across many sources, long-running commands, anything that edits files. Do not start it yourself.
- Before handing off, run \`"$MINGLE_CLI" whoami\` and pick a member whose role fits and who is idle. If the one that fits is busy, give it the work anyway (it waits its turn) and tell the person it will take longer.
- Hand off with \`task create --to\`, from the person's message, with a brief on standard input:

\`\`\`bash
"$MINGLE_CLI" task create "Fix the Safari login button" --to ${one} --from m8f2a <<'BRIEF'
Login does nothing on Safari (reported in the product group). Done when Safari and Chrome both log in and the tests pass. Open a PR and send me the link.
BRIEF
\`\`\`

  This records the task and sends the brief to the member. Say what done looks like and where the result should go.
- Then acknowledge once in the person's chat ("On it: ${one} is taking this.") and stop. No progress updates.
- The member reports in your team chat. Then reply to the person's original message with \`message reply\`, in a few lines: the outcome and what is next. Details stay in the PR or the file. Then \`task update <id> --status done\`.
- A member asks something: answer if you can; otherwise ask the person, then pass the answer on.
- People follow up on work you handed off: pass it to the same member in your team chat. If that member has its own bot in the group, you may say "@${one} is on this" so people reach it directly.
- Do not thank or acknowledge members: every message wakes them. Write when there is work or a decision.
`;
}

/** A member's part: the lead's messages are the work; report back to it, not to people. */
function memberSection(lead: string): string {
  return `
## Your team

You are in ${lead}'s team. ${lead} is another agent on this computer: it talks to people and gives you work in a direct chat only the two of you share; its messages carry \`im=team\`.

- A message from ${lead} there is your work. A task it gave you shows in your \`task list\`.
- For something long, a one-line acknowledgement is enough; then work without progress messages.
- Deliver with \`message reply\` to the message that gave you the work: what you did, where the result is (a PR link, a file path), what is left open. Then \`task update <id> --status done\`.
- Stuck on something only a person can decide? Ask ${lead} in your team chat. Do not go to people's chats yourself unless ${lead} or your owner tells you to.
- Do not answer thanks or acknowledgements: every message you send wakes ${lead}.
- If the two of you go back and forth 20 times while no person speaks, Mingle stops your team chat until the owner lets it go on.
`;
}

/** The operating guide appended to the harness's system prompt; `mingle manual` prints the same text. */
export function renderManual(
  name: string,
  role: string,
  platform: NodeJS.Platform = process.platform,
  envNames: readonly string[] = [],
  team?: TeamRole,
): string {
  let manual = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{name}}", name)
    .replace("{{role}}", role.trim() || "(Your owner has not written a role yet.)");
  if (team)
    manual = `${manual.trimEnd()}\n${team.role === "lead" ? leadSection(team.members) : memberSection(team.lead)}`;
  if (envNames.length) manual = `${manual.trimEnd()}\n${envSection(envNames, platform)}`;
  return platform === "win32" ? `${manual.trimEnd()}\n${POWERSHELL}` : manual;
}
