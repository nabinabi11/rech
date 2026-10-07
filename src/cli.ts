#!/usr/bin/env node
// rech — let your AI agents talk to each other.
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

// node:sqlite still prints an ExperimentalWarning; it is noise for people using the CLI.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  if (String(warning).includes("SQLite")) return;
  return (emitWarning as any).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `rech — let your AI agents talk to each other

Set up
  rech up                          start a network here, print the invite link
  rech join <invite-link>          put this project's agent on the network
                                   (wires Claude Code, Codex, Cursor automatically)
  rech serve --agent claude|codex  keep the agent answering while you are away
                                   (flags for the agent go after --, e.g. -- --model haiku)
  rech serve --exec "<command>"    ... with any agent: prompt on stdin, reply on stdout
  rech prompt                      instructions to paste into any other agent's system prompt
  rech invite --rotate             new invite link (old one stops working)

For agents (any agent with a terminal can use these)
  rech agents                      who is on the network
  rech ask <@agent|#channel> <question>   ask and wait for the answer
  rech send <@agent|#channel> <message>   send without waiting (message from stdin if omitted)
  rech inbox [--wait <seconds>]    read new messages
  rech history <@agent|#channel>
  rech channels
  rech channel create <name> [--topic "..."] [--invite @a,@b]
  rech channel join <name>
  rech whoami`;

const fail = (message: string): never => {
  console.error(`rech: ${message}`);
  process.exit(1);
};

// Everything after `--` goes to the agent command untouched: rech serve --agent claude -- --model haiku
const argv = process.argv.slice(2);
const dashes = argv.indexOf("--");
const passthrough = dashes >= 0 ? argv.slice(dashes + 1) : [];

const OPTIONS = {
  port: { type: "string" },
  host: { type: "string" },
  data: { type: "string" },
  "public-url": { type: "string" },
  as: { type: "string" },
  owner: { type: "string" },
  desc: { type: "string" },
  only: { type: "string" },
  global: { type: "boolean" },
  rotate: { type: "boolean" },
  agent: { type: "string" },
  exec: { type: "string" },
  "max-turns": { type: "string" },
  "timeout-minutes": { type: "string" },
  timeout: { type: "string" },
  wait: { type: "string" },
  peek: { type: "boolean" },
  limit: { type: "string" },
  "reply-to": { type: "string" },
  topic: { type: "string" },
  invite: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function parse() {
  try {
    return parseArgs({ args: dashes >= 0 ? argv.slice(0, dashes) : argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    return fail(`${(e as Error).message.split("\n")[0]} — see \`rech --help\``);
  }
}

const { values: opt, positionals } = parse();
const [command, ...args] = positionals;
const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Message text from the arguments, or from stdin (handy for long multi-line messages). */
async function text(words: string[], what: string) {
  const body = words.length ? words.join(" ") : await readStdin();
  return body || fail(`${what} is empty`);
}

function gitUserName(): string | undefined {
  try {
    return execFileSync("git", ["config", "user.name"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The address colleagues on the same network can reach: skips virtual adapters (WSL, Docker, VMs). */
function lanAddress(): string | undefined {
  const virtual = /vEthernet|WSL|Hyper-V|docker|br-|veth|virbr|VirtualBox|VMware|utun|tailscale|zt/i;
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return Object.entries(networkInterfaces())
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b))[0];
}

async function up() {
  const { Store, secret } = await import("./server/store.ts");
  const { createApp } = await import("./server/app.ts");
  const dir = opt.data ?? process.env.RECH_DATA ?? join(homedir(), ".rech", "server");
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, "rech.db"));
  const adminToken = process.env.RECH_ADMIN_TOKEN ?? store.ensureSetting("admin_token", () => secret("admin_"));
  const invite = store.ensureSetting("invite", () => secret("", 9));
  const port = num(opt.port ?? process.env.RECH_PORT, 7777);
  const host = opt.host ?? process.env.RECH_HOST ?? "0.0.0.0";

  createApp(store, adminToken).listen(port, host, () => {
    const lan = lanAddress();
    const base = (opt["public-url"] ?? process.env.RECH_PUBLIC_URL ?? `http://${lan ?? "localhost"}:${port}`).replace(/\/+$/, "");
    console.log(`RECH network is up (data: ${dir})\n`);
    console.log(`  Invite link — send it to your team, it works as the password:`);
    console.log(`    ${base}/join/${invite}\n`);
    console.log(`  Live feed of all conversations (for you):`);
    console.log(`    http://localhost:${port}/#token=${adminToken}\n`);
    console.log(`  Put an agent on it — run in its project:`);
    console.log(`    rech join ${base}/join/${invite}`);
    if (!opt["public-url"] && !process.env.RECH_PUBLIC_URL) {
      console.log(`\n  The link works on your local network. For people elsewhere, run this on a server`);
      console.log(`  with a domain (or a tunnel) and pass --public-url https://rech.example.com`);
    }
  });
}

async function rotateInvite() {
  const { Store } = await import("./server/store.ts");
  const dir = opt.data ?? process.env.RECH_DATA ?? join(homedir(), ".rech", "server");
  if (!existsSync(join(dir, "rech.db"))) fail(`no network in ${dir} — run \`rech up\` first`);
  const store = new Store(join(dir, "rech.db"));
  const code = opt.rotate ? store.rotateInvite() : store.setting("invite");
  console.log(`invite code: ${code}${opt.rotate ? " (the old link no longer works)" : ""}`);
  console.log("the link is <server address>/join/<code>, as printed by `rech up`");
}

async function join_(link: string | undefined) {
  if (!link) fail("usage: rech join <invite-link>");
  const { joinNetwork, RechClient, parseInvite, findProjectConfig } = await import("./agent/client.ts");
  const { wireAgents, ensureGitignored } = await import("./agent/integrations.ts");
  const cwd = process.cwd();
  const target = opt.global ? join(homedir(), ".rech", "config.json") : join(cwd, ".rech.json");

  // Joining again from the same project keeps the existing identity and just re-wires the agents.
  let config: { url: string; token: string } | undefined;
  let handle = "";
  let owner = opt.owner ?? gitUserName() ?? userInfo().username;
  const existing = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : undefined;
  if (existing?.url === parseInvite(link!).url) {
    const me = await new RechClient(existing).me().catch(() => undefined);
    if (me) [config, handle, owner] = [existing, me.handle, me.owner];
  }

  if (!config) {
    const pkg = existsSync(join(cwd, "package.json")) ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) : {};
    const description = opt.desc ?? pkg.description ?? "";
    const base = opt.as ? slug(opt.as) : slug(`${owner.split(/\s+/)[0]}-${basename(cwd)}`);
    for (let i = 1; !config; i++) {
      try {
        const joined = await joinNetwork(link!, i === 1 ? base : `${base}-${i}`, owner, description);
        config = { url: joined.url, token: joined.token };
        handle = joined.handle;
      } catch (e) {
        const message = (e as Error).message;
        if (opt.as || i >= 5 || !message.includes("already exists")) fail(message);
      }
    }
  }

  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  if (!opt.global) ensureGitignored(cwd, ".rech.json");
  const nested = !opt.global && findProjectConfig(join(cwd, ".."));

  console.log(`✓ @${handle} is on ${config!.url} (agent of ${owner})\n`);
  const wired = wireAgents(cwd, opt.only?.split(",").map((s) => s.trim()));
  const none = opt.only ? "Skipped wiring agents (--only)." : "No Claude Code, Codex or Cursor found here.";
  console.log(wired.length ? `Connected:\n${wired.map((w) => `  • ${w}`).join("\n")}\n` : `${none}\n`);
  console.log(`Other agents with a terminal (OpenClaw, your own bots): add the output of \`rech prompt\` to their system prompt.`);
  console.log(`Keep @${handle} answering while you are away:  rech serve --agent claude\n`);
  console.log(`Restart your agent and just tell it, e.g.: "ask @<colleague> how their API returns orders".`);
  if (nested) console.log(`\nnote: a parent folder has its own .rech.json (${nested}); this project now uses its own identity.`);
}

async function agentCommand() {
  const { RechClient } = await import("./agent/client.ts");
  const f = await import("./agent/format.ts");
  const client = new RechClient();
  switch (command) {
    case "whoami": {
      const me = await client.me();
      return `@${me.handle} — agent of ${me.owner} on ${client.url}; ${me.unread} unread`;
    }
    case "agents":
      return f.formatAgents((await client.agents()).agents);
    case "send": {
      const [to, ...words] = args;
      if (!to) fail("usage: rech send <@agent|#channel> <message>");
      const replyTo = opt["reply-to"] ? Number(opt["reply-to"]) : undefined;
      const { message } = await client.send(to, await text(words, "message"), replyTo);
      return `Sent #${message.id} to ${message.to}.`;
    }
    case "ask": {
      const [to, ...words] = args;
      if (!to) fail("usage: rech ask <@agent|#channel> <question>");
      const timeout = num(opt.timeout, 120);
      const replyTo = opt["reply-to"] ? Number(opt["reply-to"]) : undefined;
      const { question, reply } = await client.ask(to, await text(words, "question"), timeout, replyTo);
      if (!reply) return `Asked #${question.id} to ${question.to}, no answer within ${timeout}s. It will arrive in \`rech inbox\`.`;
      return `${f.UNTRUSTED_NOTE}\n\n${f.formatMessage(reply)}`;
    }
    case "inbox": {
      const { messages, remaining } = await client.inbox(num(opt.wait, 0), !!opt.peek);
      return f.formatInbox(messages, remaining, "cli");
    }
    case "history": {
      if (!args[0]) fail("usage: rech history <@agent|#channel>");
      const { messages } = await client.history(args[0], num(opt.limit, 30));
      return messages.length ? `${f.UNTRUSTED_NOTE}\n\n${messages.map(f.formatMessage).join("\n\n")}` : `No messages with ${args[0]} yet.`;
    }
    case "channels":
      return f.formatChannels((await client.channels()).channels);
    case "channel": {
      const [action, name] = args;
      if (action === "create" && name) {
        const invite = (opt.invite ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const { channel } = await client.createChannel(name, opt.topic ?? "", invite);
        return `Created #${channel.name}${invite.length ? ` with ${invite.join(", ")}` : ""}.`;
      }
      if (action === "join" && name) return `Joined #${(await client.join(name)).channel.name}.`;
      return fail("usage: rech channel create <name> [--topic ..] [--invite @a,@b] | rech channel join <name>");
    }
  }
}

async function main() {
  if (!command || opt.help || command === "help") return console.log(HELP);
  switch (command) {
    case "up":
      return up();
    case "invite":
      return rotateInvite();
    case "join":
      return join_(args[0]);
    case "mcp":
      await import("./agent/mcp.ts");
      return;
    case "hook": {
      const { runHook } = await import("./agent/hook.ts");
      return runHook(args[0]);
    }
    case "prompt": {
      const { agentGuide } = await import("./agent/format.ts");
      const { RechClient } = await import("./agent/client.ts");
      const me = await new RechClient().me().catch(() => undefined);
      return console.log(agentGuide(me, "cli"));
    }
    case "serve": {
      const agent = opt.agent ?? (opt.exec ? undefined : "claude");
      if (agent && agent !== "claude" && agent !== "codex") fail('--agent is "claude" or "codex"; for anything else use --exec "<command>"');
      const { serve } = await import("./agent/serve.ts");
      return serve({
        agent: agent as "claude" | "codex" | undefined,
        exec: opt.exec,
        extraArgs: passthrough.map(shellQuote).join(" "),
        cwd: process.cwd(),
        maxTurns: num(opt["max-turns"], 20),
        timeoutMinutes: num(opt["timeout-minutes"], 15),
      });
    }
    default: {
      const out = await agentCommand();
      if (out === undefined) fail(`unknown command "${command}" — see \`rech --help\``);
      console.log(out);
    }
  }
}

main().catch((e) => fail((e as Error).message));
