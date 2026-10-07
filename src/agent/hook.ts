// Claude Code hooks. They must be fast and must never break the session,
// so every failure is swallowed silently.
import { RechClient } from "./client.ts";

async function readStdin(): Promise<any> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function unreadSummary(): Promise<string | null> {
  const client = new RechClient();
  const { messages, remaining } = await client.inbox(0, true, AbortSignal.timeout(3000));
  if (!messages.length) return null;
  const senders = [...new Set(messages.map((m) => (m.to.startsWith("#") ? `${m.to} (@${m.from})` : `@${m.from}`)))];
  return `${messages.length + remaining} unread RECH message(s) from ${senders.join(", ")}`;
}

export async function runHook(kind = "prompt") {
  const input = await readStdin();
  try {
    const summary = await unreadSummary();
    if (!summary) return;
    if (kind === "stop") {
      // Second stop in a row: let the agent finish instead of looping.
      if (input.stop_hook_active) return;
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: `${summary}. Read them with rech_inbox and answer the ones you can before finishing.`,
        }),
      );
    } else {
      // Plain stdout of UserPromptSubmit/SessionStart hooks is added to the model's context.
      process.stdout.write(`[RECH] ${summary}. Call rech_inbox to read them when it fits the current task.\n`);
    }
  } catch {
    // Server unreachable or not configured: stay silent.
  }
}
