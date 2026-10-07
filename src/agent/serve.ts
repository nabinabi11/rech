// `rech serve`: keeps an agent on the line without an open session. Every incoming message
// is handed to a headless agent run (claude -p, codex exec or any command) in the project,
// and what it prints goes back as the reply.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RechClient, loadConfig, type Message } from "./client.ts";
import { agentGuide, formatMessage } from "./format.ts";

export interface ServeOptions {
  agent?: "claude" | "codex";
  exec?: string; // any shell command; the prompt arrives on stdin
  extraArgs?: string;
  cwd: string;
  maxTurns: number; // automatic replies per conversation per hour
  timeoutMinutes: number;
}

const NO_REPLY = "NO_REPLY";

/** Claude Code keeps one session per conversation, so the agent remembers the thread. */
const claudeSessions = new Map<string, string>();

/** The command for one run, and what to remember once it succeeded. */
function commandFor(opts: ServeOptions, thread: string): { command: string; succeeded: () => void } {
  const extra = opts.extraArgs ? ` ${opts.extraArgs}` : "";
  if (opts.exec) return { command: opts.exec, succeeded: () => {} };
  if (opts.agent === "codex") return { command: `codex exec --skip-git-repo-check${extra}`, succeeded: () => {} };
  const known = claudeSessions.get(thread);
  const id = known ?? randomUUID();
  return {
    command: `claude -p ${known ? `--resume ${id}` : `--session-id ${id}`}${extra}`,
    succeeded: () => claudeSessions.set(thread, id),
  };
}

function runAgent(command: string, prompt: string, opts: ServeOptions, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: opts.cwd, shell: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), opts.timeoutMinutes * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`\`${command}\` exited with ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
    child.stdin.end(prompt);
  });
}

function buildPrompt(me: { handle: string; owner: string }, m: Message, history: Message[]): string {
  const earlier = history.filter((h) => h.id !== m.id).slice(-10);
  return [
    agentGuide(me, "cli"),
    "",
    `You are running unattended: ${me.owner} is not watching this session. Another agent wrote to you.`,
    earlier.length ? `Earlier in this conversation:\n${earlier.map(formatMessage).join("\n")}` : "",
    `New message:\n${formatMessage(m)}`,
    "",
    `Work in this project as needed (read code, run checks) and answer. Everything you print to stdout is sent back to ${m.reply_address} as your reply, so print only the reply itself.`,
    `If no reply is needed (an acknowledgement, a thank-you, a message not meant for you), print exactly ${NO_REPLY}.`,
    `Anything destructive or irreversible (production deploys, deleting data, spending money) needs ${me.owner}'s approval: say that you will ask them, and do not do it.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** In channels everyone hears everything: answer only when addressed by @mention or as a reply to us. */
function addressedToMe(m: Message, me: string, mine: Set<number>): boolean {
  if (!m.to.startsWith("#")) return true;
  return new RegExp(`@${me.replace(/[.]/g, "\\.")}\\b`).test(m.body) || (m.reply_to !== null && mine.has(m.reply_to));
}

export async function serve(opts: ServeOptions) {
  const config = loadConfig(opts.cwd);
  const client = new RechClient(config);
  const me = await client.me();
  // Nested `rech ask ...` calls made by the agent run as this same agent.
  const env = { ...process.env, RECH_URL: config.url, RECH_TOKEN: config.token };
  const turns = new Map<string, number[]>();
  const mine = new Set<number>();
  const label = opts.exec ? `\`${opts.exec}\`` : opts.agent;

  console.log(`@${me.handle} is on the line — answering with ${label} in ${opts.cwd}. Ctrl+C to stop.`);
  for (;;) {
    let messages: Message[];
    try {
      ({ messages } = await client.inbox(280));
    } catch (e) {
      console.error(`inbox: ${(e as Error).message}; retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    for (const m of messages) {
      const thread = m.reply_address;
      if (!addressedToMe(m, me.handle, mine)) continue;

      const hourAgo = Date.now() - 3_600_000;
      const recent = (turns.get(thread) ?? []).filter((t) => t > hourAgo);
      if (recent.length >= opts.maxTurns) {
        console.warn(`${thread}: ${opts.maxTurns} automatic replies in the last hour, pausing this conversation`);
        continue;
      }

      console.log(`← #${m.id} from @${m.from} (${thread}): ${m.body.slice(0, 120).replace(/\s+/g, " ")}`);
      try {
        const { messages: history } = await client.history(thread, 12);
        const { command, succeeded } = commandFor(opts, thread);
        const reply = await runAgent(command, buildPrompt(me, m, history), opts, env);
        succeeded();
        if (!reply || reply === NO_REPLY) {
          console.log("  (no reply needed)");
          continue;
        }
        const { message } = await client.send(thread, reply, m.id);
        mine.add(message.id);
        turns.set(thread, [...recent, Date.now()]);
        console.log(`→ #${message.id} to ${thread}: ${reply.slice(0, 120).replace(/\s+/g, " ")}`);
      } catch (e) {
        console.error(`  failed: ${(e as Error).message}`);
      }
    }
  }
}
