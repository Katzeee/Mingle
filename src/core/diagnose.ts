/**
 * The prompt the owner gives an agent with a shell on this computer (Claude Code, Codex) so it finds
 * out why a Mingle agent misbehaves and reports it to the maintainers as a GitHub issue
 * (docs/spec.md 4.11). Mingle itself sends nothing anywhere: the owner's own agent files the issue,
 * after the owner has read it. English: it is for a model, which talks to the owner in their language.
 */

export const REPOSITORY = "earayu/Mingle";

export function diagnosisPrompt(
  agent: { readonly id: string; readonly name: string },
  diagnostics: string,
  cli: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const run = (args: string) => (platform === "win32" ? `& "${cli}" ${args}` : `"${cli}" ${args}`);
  const shell = platform === "win32" ? "powershell" : "bash";
  const url = `https://github.com/${REPOSITORY}`;
  return [
    `Mingle (${url}) is an open-source app on this computer that runs long-lived agents in chat apps, each driven by a coding agent harness such as Claude Code or Codex. Its agent ${agent.name} (${agent.id}) is not working the way the owner expects. Find out why, then report it to the Mingle maintainers as a GitHub issue.`,
    "",
    "Diagnose and report only: do not change Mingle's code, settings or data, and do not open a pull request.",
    "",
    "1. Unless the owner has already said, ask them what they saw: what they did, what they expected, what happened instead, and about when.",
    "",
    "2. Gather facts with Mingle's own command. The last two need Mingle running; the log does not.",
    "",
    `\`\`\`${shell}`,
    `${run(`log --agent ${agent.id}`)}   # Mingle's log lines about this agent`,
    `${run("log --lines 300")}   # everything around them: restarts, crashes, sign-in and connection problems`,
    `${run(`agent diagnostics ${agent.id}`)}   # versions, brain, session, status, chat apps, message counts`,
    `${run("status")}`,
    "```",
    "",
    "   The diagnostics as the owner copied them:",
    "",
    "```text",
    diagnostics.trimEnd(),
    "```",
    "",
    `3. Find the cause in Mingle's source. Read it at the running version: \`git clone ${url}.git\`, then \`git checkout v${version}\`. Start from AGENTS.md and docs/spec.md, then follow the code from the log lines. Point to the file and function where it goes wrong if you can, and say how sure you are. If the cause is outside Mingle (the harness's sign-in or usage limit, the chat app, this computer's setup), tell the owner how to fix it, and file an issue only if Mingle should have handled or explained it better.`,
    "",
    `4. Look for an existing issue first: \`gh issue list --repo ${REPOSITORY} --state all --search "<a few words>"\`. If one covers it, add your findings there as a comment instead of opening a new one.`,
    "",
    "5. Draft the issue in English: a title that names the symptom; what happened; steps to reproduce; what was expected; the likely cause, with file references; the diagnostics and the log lines that matter; Mingle, harness and system versions.",
    "   Remove anything private before it leaves this computer: message text, names of people and chats, chat app user and chat IDs, phone numbers and email addresses, tokens and keys, environment variable values. Replace the home folder in paths with ~.",
    "",
    `6. Show the owner the full draft and file it only after they agree: \`gh issue create --repo ${REPOSITORY} --title "..." --body-file <file>\`. If gh is not installed or not signed in, give the owner the draft to paste at ${url}/issues/new.`,
    "",
    "7. Tell the owner, in a few sentences, what you found and the issue's link.",
    "",
  ].join("\n");
}
