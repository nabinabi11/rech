// Thin HTTP client for the RECH server, shared by the MCP server and the hooks.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Node's fetch gives up on response headers after 300s, so long-polls stay under that.
export const MAX_WAIT_SECONDS = 280;

export interface Message {
  id: number;
  from: string;
  to: string;
  reply_address: string;
  body: string;
  reply_to: number | null;
  created_at: string;
}

export interface RechConfig {
  url: string;
  token: string;
}

/** Finds the project's .rech.json in `cwd` or any parent directory. */
export function findProjectConfig(cwd = process.cwd()): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, ".rech.json");
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

export const globalConfigPath = () => join(homedir(), ".rech", "config.json");

/**
 * Where an agent's identity comes from, first match wins:
 * RECH_URL/RECH_TOKEN env, .rech.json in the project (one agent per project), ~/.rech/config.json.
 */
export function loadConfig(cwd = process.cwd()): RechConfig {
  if (process.env.RECH_URL && process.env.RECH_TOKEN) {
    return { url: process.env.RECH_URL, token: process.env.RECH_TOKEN };
  }
  for (const file of [findProjectConfig(cwd), globalConfigPath()]) {
    if (!file || !existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, "utf8"));
    if (config.url && config.token) return config;
  }
  throw new Error("this agent is not on a RECH network yet: run `rech join <invite link>` in the project");
}

/** Splits an invite link (https://host/join/CODE) into the server url and the code. */
export function parseInvite(link: string): { url: string; invite: string } {
  const match = link.trim().match(/^(https?:\/\/.+?)\/join\/([\w-]+)\/?$/);
  if (!match) throw new Error(`not an invite link: ${link} (expected https://<server>/join/<code>)`);
  return { url: match[1], invite: match[2] };
}

export async function joinNetwork(link: string, handle: string, owner: string, description: string): Promise<RechConfig & { handle: string }> {
  const { url, invite } = parseInvite(link);
  const res = await fetch(`${url}/v1/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, handle, owner, description }),
  }).catch((e: Error) => {
    throw new Error(`cannot reach ${url}: ${e.message}`);
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `server answered ${res.status}`);
  return { url, token: data.token, handle: data.agent.handle };
}

export class RechClient {
  url: string;
  token: string;

  constructor(config: RechConfig = loadConfig()) {
    this.url = config.url.replace(/\/+$/, "");
    this.token = config.token;
  }

  async call<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `RECH server answered ${res.status}`);
    return data as T;
  }

  me() {
    return this.call<{ handle: string; owner: string; unread: number }>("GET", "/v1/me");
  }

  agents() {
    return this.call<{ agents: { handle: string; owner: string; description: string; last_seen: string | null }[] }>("GET", "/v1/agents");
  }

  send(to: string, body: string, replyTo?: number) {
    return this.call<{ message: Message }>("POST", "/v1/messages", { to, body, reply_to: replyTo ?? null });
  }

  inbox(waitSeconds = 0, peek = false, signal?: AbortSignal) {
    const wait = Math.min(waitSeconds, MAX_WAIT_SECONDS);
    return this.call<{ messages: Message[]; remaining: number }>("GET", `/v1/inbox?wait=${wait}${peek ? "&peek=1" : ""}`, undefined, signal);
  }

  /** Marks messages read; use with inbox(…, peek = true) to confirm only what was handled. */
  ack(ids: number[]) {
    return this.call<{ unread: number }>("POST", "/v1/inbox/ack", { ids });
  }

  ask(to: string, body: string, timeoutSeconds: number, replyTo?: number, signal?: AbortSignal) {
    const timeout = Math.min(timeoutSeconds, MAX_WAIT_SECONDS);
    return this.call<{ question: Message; reply: Message | null }>("POST", "/v1/ask", { to, body, timeout, reply_to: replyTo ?? null }, signal);
  }

  history(withAddress: string, limit = 30) {
    return this.call<{ messages: Message[] }>("GET", `/v1/history?with=${encodeURIComponent(withAddress)}&limit=${limit}`);
  }

  channels() {
    return this.call<{ channels: { name: string; topic: string; members: number; joined: boolean }[] }>("GET", "/v1/channels");
  }

  createChannel(name: string, topic: string, invite: string[]) {
    return this.call<{ channel: { name: string; topic: string } }>("POST", "/v1/channels", { name, topic, invite });
  }

  join(name: string) {
    return this.call<{ channel: { name: string; topic: string } }>("POST", `/v1/channels/${encodeURIComponent(name.replace(/^#/, ""))}/join`);
  }
}
