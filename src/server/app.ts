import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { Store, RechError, MAX_BODY, safeEqual, type Agent, type MessageRow } from "./store.ts";

const MAX_WAIT_SECONDS = 600;
const FEED_HTML = readFileSync(new URL("./feed.html", import.meta.url), "utf8");
const JOIN_HTML = readFileSync(new URL("./join.html", import.meta.url), "utf8");

/** Wakes up long-polling requests when something is delivered to an agent. */
class Bus {
  private waiters = new Map<number, Set<() => void>>();

  notify(agentIds: number[]) {
    for (const id of agentIds) {
      const set = this.waiters.get(id);
      if (!set) continue;
      this.waiters.delete(id);
      for (const wake of set) wake();
    }
  }

  /** Resolves on the next delivery to the agent, on timeout, or when the client goes away. */
  wait(agentId: number, ms: number, res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(agentId);
      if (!set) this.waiters.set(agentId, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        res.off("close", done);
        set!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      res.once("close", done);
      set.add(done);
    });
  }
}

/** What an agent sees: who wrote, where, and the address to answer to. */
function view(m: MessageRow, viewer: string) {
  const where = m.kind === "channel" ? `#${m.channel}` : `@${m.sender === viewer ? m.recipient : m.sender}`;
  return {
    id: m.id,
    from: m.sender,
    to: m.kind === "channel" ? `#${m.channel}` : `@${m.recipient}`,
    reply_address: where,
    body: m.body,
    reply_to: m.reply_to,
    created_at: m.created_at,
  };
}

const publicAgent = (a: Agent) => ({
  handle: a.handle,
  owner: a.owner,
  description: a.description,
  last_seen: a.last_seen,
});

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY * 2) throw new RechError(413, "request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RechError(400, "body must be JSON");
  }
}

const str = (v: unknown, field: string, required = true): string => {
  if (v === undefined || v === null) {
    if (required) throw new RechError(400, `${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new RechError(400, `${field} must be a string`);
  return v;
};

const seconds = (v: unknown, fallback: number) => {
  const n = v === undefined || v === null || v === "" ? fallback : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new RechError(400, "wait/timeout must be a non-negative number of seconds");
  return Math.min(n, MAX_WAIT_SECONDS);
};

const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

/** The address people use to reach this server, as seen from their side (works behind proxies). */
function publicUrl(req: IncomingMessage) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface AppOptions {
  /** npm tarball of rech itself, served at /rech.tgz so people install straight from their network. */
  packageFile?: string;
}

export function createApp(store: Store, adminToken: string, options: AppOptions = {}) {
  const bus = new Bus();
  const packageFile = options.packageFile && existsSync(options.packageFile) ? options.packageFile : undefined;

  function auth(req: IncomingMessage): Agent {
    const token = bearer(req);
    const agent = token ? store.agentByToken(token) : undefined;
    if (!agent) throw new RechError(401, "missing or invalid agent token");
    store.touch(agent.id);
    return agent;
  }

  function admin(req: IncomingMessage) {
    const token = bearer(req);
    if (!adminToken || !token || !safeEqual(token, adminToken)) throw new RechError(401, "missing or invalid admin token");
  }

  function post(me: Agent, to: string, body: string, replyTo: unknown) {
    if (replyTo !== undefined && replyTo !== null && !Number.isInteger(replyTo)) {
      throw new RechError(400, "reply_to must be a message id");
    }
    const thread = store.resolveAddress(me, to);
    const { message, recipients } = store.post(me, thread, body, (replyTo as number | undefined) ?? null);
    bus.notify(recipients);
    return { thread, message };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const route = `${req.method} ${path}`;

    if (route === "GET /") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(FEED_HTML);
    }
    if (route === "GET /health") return send(res, 200, { ok: true });

    const joinPage = path.match(/^\/join\/([\w-]+)$/);
    if (req.method === "GET" && joinPage) {
      const base = publicUrl(req);
      const install = packageFile ? `npm install -g ${base}/rech.tgz` : "npm install -g rech-agents";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(JOIN_HTML.replaceAll("{{INSTALL}}", escapeHtml(install)).replaceAll("{{LINK}}", escapeHtml(`${base}/join/${joinPage[1]}`)));
    }

    if (route === "GET /rech.tgz") {
      if (!packageFile) throw new RechError(404, "this server does not distribute the rech package");
      res.writeHead(200, { "content-type": "application/gzip" });
      return res.end(readFileSync(packageFile));
    }

    if (route === "POST /v1/join") {
      const b = await readJson(req);
      const { agent, token } = store.join(str(b.invite, "invite"), str(b.handle, "handle"), str(b.owner, "owner"), str(b.description, "description", false));
      return send(res, 201, { agent: publicAgent(agent), token });
    }

    // --- admin ---
    if (route === "POST /v1/admin/agents") {
      admin(req);
      const b = await readJson(req);
      const { agent, token } = store.createAgent(str(b.handle, "handle"), str(b.owner, "owner"), str(b.description, "description", false));
      return send(res, 201, { agent: publicAgent(agent), token });
    }
    if (route === "GET /v1/admin/agents") {
      admin(req);
      return send(res, 200, { agents: store.listAgents().map(publicAgent) });
    }
    const removeAgent = path.match(/^\/v1\/admin\/agents\/([^/]+)$/);
    if (req.method === "DELETE" && removeAgent) {
      admin(req);
      const agent = store.removeAgent(decodeURIComponent(removeAgent[1]));
      return send(res, 200, { removed: agent.handle });
    }
    if (route === "POST /v1/admin/invite") {
      admin(req);
      return send(res, 200, { link: `${publicUrl(req)}/join/${store.rotateInvite()}` });
    }
    if (route === "GET /v1/admin/feed") {
      admin(req);
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      return send(res, 200, {
        messages: store.feed(after).map((m) => ({ ...view(m, ""), to: m.kind === "channel" ? `#${m.channel}` : `@${m.recipient}` })),
      });
    }

    // --- agents ---
    const me = auth(req);

    if (route === "GET /v1/me") return send(res, 200, { ...publicAgent(me), unread: store.unreadCount(me.id) });
    if (route === "GET /v1/agents") return send(res, 200, { agents: store.listAgents().map(publicAgent) });

    if (route === "POST /v1/messages") {
      const b = await readJson(req);
      const { message } = post(me, str(b.to, "to"), str(b.body, "body"), b.reply_to);
      return send(res, 201, { message: view(message, me.handle) });
    }

    if (route === "GET /v1/inbox") {
      // Long-poll: answer at once if there is mail, otherwise wait for a delivery.
      const deadline = Date.now() + seconds(url.searchParams.get("wait"), 0) * 1000;
      const peek = url.searchParams.get("peek") === "1";
      let messages = store.unread(me.id);
      while (!messages.length && Date.now() < deadline && !res.closed) {
        await bus.wait(me.id, deadline - Date.now(), res);
        messages = store.unread(me.id);
      }
      if (!peek) store.markRead(me.id, messages.map((m) => m.id));
      // Unread beyond this page; with peek the returned messages are still unread themselves.
      const remaining = store.unreadCount(me.id) - (peek ? messages.length : 0);
      return send(res, 200, { messages: messages.map((m) => view(m, me.handle)), remaining });
    }

    if (route === "POST /v1/inbox/ack") {
      // Pairs with inbox?peek=1: a message counts as read only once it was actually handled.
      const b = await readJson(req);
      if (!Array.isArray(b.ids) || !b.ids.every(Number.isInteger)) throw new RechError(400, "ids must be a list of message ids");
      store.markRead(me.id, b.ids);
      return send(res, 200, { unread: store.unreadCount(me.id) });
    }

    if (route === "POST /v1/ask") {
      // Send, then hold the request open until the other side answers or time runs out.
      const b = await readJson(req);
      const deadline = Date.now() + seconds(b.timeout, 120) * 1000;
      const { thread, message } = post(me, str(b.to, "to"), str(b.body, "body"), b.reply_to);
      let reply = store.findReply(me.id, thread, message.id);
      while (!reply && Date.now() < deadline && !res.closed) {
        await bus.wait(me.id, deadline - Date.now(), res);
        reply = store.findReply(me.id, thread, message.id);
      }
      if (reply) store.markRead(me.id, [reply.id]);
      return send(res, 200, { question: view(message, me.handle), reply: reply ? view(reply, me.handle) : null });
    }

    if (route === "GET /v1/history") {
      const thread = store.resolveAddress(me, str(url.searchParams.get("with"), "with"));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 30) || 30, 200);
      return send(res, 200, { messages: store.history(thread, limit).map((m) => view(m, me.handle)) });
    }

    if (route === "GET /v1/channels") return send(res, 200, { channels: store.listChannels(me) });

    if (route === "POST /v1/channels") {
      const b = await readJson(req);
      const invite = Array.isArray(b.invite) ? b.invite.map((h: unknown) => str(h, "invite[]")) : [];
      const channel = store.createChannel(me, str(b.name, "name"), str(b.topic, "topic", false), invite);
      if (invite.length) {
        // Invitees learn about the channel through their inbox.
        const { recipients } = store.post(me, channel, `@${me.handle} created ${channel.name} and added you. Topic: ${channel.topic || "—"}`);
        bus.notify(recipients);
      }
      return send(res, 201, { channel: { name: channel.name!.slice(1), topic: channel.topic } });
    }

    const join = path.match(/^\/v1\/channels\/([^/]+)\/join$/);
    if (req.method === "POST" && join) {
      const channel = store.joinChannel(me, decodeURIComponent(join[1]));
      return send(res, 200, { channel: { name: channel.name!.slice(1), topic: channel.topic } });
    }

    throw new RechError(404, `no route ${route}`);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof RechError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: "internal error" });
    });
  });
}
