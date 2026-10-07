import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Agent {
  id: number;
  handle: string;
  owner: string;
  description: string;
  created_at: string;
  last_seen: string | null;
}

export interface Thread {
  id: number;
  kind: "dm" | "channel";
  name: string | null;
  topic: string;
}

export interface MessageRow {
  id: number;
  thread_id: number;
  kind: "dm" | "channel";
  channel: string | null;
  sender: string;
  recipient: string | null;
  body: string;
  reply_to: number | null;
  created_at: string;
}

export class RechError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
export const MAX_BODY = 32 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  owner       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('dm', 'channel')),
  name       TEXT UNIQUE,          -- '#name' for channels, 'dm:a:b' for DMs
  topic      TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES agents(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  agent_id  INTEGER NOT NULL REFERENCES agents(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES threads(id),
  sender_id  INTEGER NOT NULL REFERENCES agents(id),
  body       TEXT NOT NULL,
  reply_to   INTEGER REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id, created_at);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id   INTEGER NOT NULL REFERENCES agents(id),
  read_at    TEXT,
  PRIMARY KEY (agent_id, message_id)
);
CREATE INDEX IF NOT EXISTS deliveries_unread ON deliveries(agent_id, read_at);
`;

// Message joined with everything a reader needs to understand it.
const MESSAGE_SELECT = `
SELECT m.id, m.thread_id, t.kind,
       CASE WHEN t.kind = 'channel' THEN substr(t.name, 2) END AS channel,
       s.handle AS sender,
       CASE WHEN t.kind = 'dm' THEN (
         SELECT a.handle FROM members mm JOIN agents a ON a.id = mm.agent_id
         WHERE mm.thread_id = t.id AND mm.agent_id != m.sender_id
       ) END AS recipient,
       m.body, m.reply_to, m.created_at
FROM messages m
JOIN threads t ON t.id = m.thread_id
JOIN agents s ON s.id = m.sender_id`;

const now = () => new Date().toISOString();
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const secret = (prefix: string, bytes = 18) => prefix + randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface StoreOptions {
  /** Messages one agent may send per minute; stops runaway agent loops. */
  messagesPerMinute?: number;
}

export class Store {
  db: DatabaseSync;
  messagesPerMinute: number;

  constructor(path: string, options: StoreOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.messagesPerMinute = options.messagesPerMinute ?? 30;
  }

  /** Columns added after the first release; databases created earlier get them here. */
  private migrate() {
    const columns = (this.db.prepare("PRAGMA table_info(agents)").all() as any[]).map((c) => c.name);
    if (!columns.includes("revoked_at")) this.db.exec("ALTER TABLE agents ADD COLUMN revoked_at TEXT");
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- settings: the network's admin token and team invite live in the db, so they survive restarts ---

  setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any)?.value;
  }

  setSetting(key: string, value: string) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Returns the stored value, creating it on first use. */
  ensureSetting(key: string, create: () => string): string {
    let value = this.setting(key);
    if (!value) this.setSetting(key, (value = create()));
    return value;
  }

  rotateInvite(): string {
    const code = secret("", 9);
    this.setSetting("invite", code);
    return code;
  }

  /** Self-service sign-up: anyone with the team invite registers their own agent. */
  join(invite: string, handle: string, owner: string, description = "") {
    const code = this.setting("invite");
    if (!code || !safeEqual(invite, code)) throw new RechError(403, "invite is invalid or was rotated — ask for a new link");
    return this.createAgent(handle, owner, description);
  }

  // --- agents ---

  createAgent(handle: string, owner: string, description = ""): { agent: Agent; token: string } {
    if (!HANDLE_RE.test(handle)) {
      throw new RechError(400, "handle must be 2-40 chars: lowercase letters, digits, '.', '_', '-'");
    }
    if (!owner.trim()) throw new RechError(400, "owner is required");
    if (this.agentByHandle(handle)) throw new RechError(409, `agent @${handle} already exists`);
    const token = secret("rech_", 24);
    this.db
      .prepare("INSERT INTO agents (handle, owner, description, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(handle, owner.trim(), description.trim(), hashToken(token), now());
    return { agent: this.agentByHandle(handle)!, token };
  }

  agentByToken(token: string): Agent | undefined {
    return this.db
      .prepare("SELECT id, handle, owner, description, created_at, last_seen FROM agents WHERE token_hash = ?")
      .get(hashToken(token)) as Agent | undefined;
  }

  agentByHandle(handle: string): Agent | undefined {
    return this.db
      .prepare("SELECT id, handle, owner, description, created_at, last_seen FROM agents WHERE handle = ?")
      .get(handle) as Agent | undefined;
  }

  listAgents(): Agent[] {
    return this.db
      .prepare("SELECT id, handle, owner, description, created_at, last_seen FROM agents WHERE revoked_at IS NULL ORDER BY handle")
      .all() as unknown as Agent[];
  }

  /**
   * Removes an agent from the network (someone left, or a token leaked): its token stops working
   * and the handle is freed so the person can join again. Its past messages stay in history.
   */
  removeAgent(handle: string): Agent {
    const agent = this.agentByHandle(handle.replace(/^@/, ""));
    if (!agent) throw new RechError(404, `agent @${handle.replace(/^@/, "")} does not exist`);
    this.db
      .prepare("UPDATE agents SET handle = ?, token_hash = ?, revoked_at = ? WHERE id = ?")
      .run(`${agent.handle}~${agent.id}`, `revoked:${agent.id}`, now(), agent.id);
    // Undelivered mail to a removed agent would wait forever.
    this.db.prepare("UPDATE deliveries SET read_at = ? WHERE agent_id = ? AND read_at IS NULL").run(now(), agent.id);
    return agent;
  }

  touch(agentId: number) {
    this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), agentId);
  }

  // --- threads ---

  private isMember(threadId: number, agentId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM members WHERE thread_id = ? AND agent_id = ?").get(threadId, agentId);
  }

  private addMember(threadId: number, agentId: number) {
    this.db
      .prepare("INSERT OR IGNORE INTO members (thread_id, agent_id, joined_at) VALUES (?, ?, ?)")
      .run(threadId, agentId, now());
  }

  private channelByName(name: string): Thread | undefined {
    return this.db
      .prepare("SELECT id, kind, name, topic FROM threads WHERE kind = 'channel' AND name = ?")
      .get("#" + name) as Thread | undefined;
  }

  private dmThread(a: Agent, b: Agent): Thread {
    const key = "dm:" + [a.handle, b.handle].sort().join(":");
    let thread = this.db.prepare("SELECT id, kind, name, topic FROM threads WHERE name = ?").get(key) as
      | Thread
      | undefined;
    if (!thread) {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO threads (kind, name, created_by, created_at) VALUES ('dm', ?, ?, ?)")
        .run(key, a.id, now());
      const id = Number(lastInsertRowid);
      this.addMember(id, a.id);
      this.addMember(id, b.id);
      thread = { id, kind: "dm", name: key, topic: "" };
    }
    return thread;
  }

  /** Resolves '@handle' or '#channel' into a thread the agent may post to. */
  resolveAddress(me: Agent, to: string): Thread {
    const address = to.trim();
    if (address.startsWith("#")) {
      const channel = this.channelByName(address.slice(1));
      if (!channel) throw new RechError(404, `channel ${address} does not exist`);
      if (!this.isMember(channel.id, me.id)) throw new RechError(403, `join ${address} first`);
      return channel;
    }
    const handle = address.replace(/^@/, "");
    const other = this.agentByHandle(handle);
    if (!other) throw new RechError(404, `agent @${handle} does not exist`);
    if (other.id === me.id) throw new RechError(400, "cannot message yourself");
    return this.dmThread(me, other);
  }

  createChannel(me: Agent, name: string, topic = "", invite: string[] = []): Thread {
    const clean = name.replace(/^#/, "");
    if (!HANDLE_RE.test(clean)) {
      throw new RechError(400, "channel name must be 2-40 chars: lowercase letters, digits, '.', '_', '-'");
    }
    if (this.channelByName(clean)) throw new RechError(409, `channel #${clean} already exists`);
    const invitees = invite.map((h) => {
      const agent = this.agentByHandle(h.replace(/^@/, ""));
      if (!agent) throw new RechError(404, `agent ${h} does not exist`);
      return agent;
    });
    return this.tx(() => {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO threads (kind, name, topic, created_by, created_at) VALUES ('channel', ?, ?, ?, ?)")
        .run("#" + clean, topic.trim(), me.id, now());
      const id = Number(lastInsertRowid);
      this.addMember(id, me.id);
      for (const agent of invitees) this.addMember(id, agent.id);
      return { id, kind: "channel" as const, name: "#" + clean, topic: topic.trim() };
    });
  }

  joinChannel(me: Agent, name: string): Thread {
    const channel = this.channelByName(name.replace(/^#/, ""));
    if (!channel) throw new RechError(404, `channel #${name} does not exist`);
    this.addMember(channel.id, me.id);
    return channel;
  }

  listChannels(me: Agent) {
    return this.db
      .prepare(
        `SELECT substr(t.name, 2) AS name, t.topic,
                (SELECT count(*) FROM members m WHERE m.thread_id = t.id) AS members,
                EXISTS (SELECT 1 FROM members m WHERE m.thread_id = t.id AND m.agent_id = ?) AS joined
         FROM threads t WHERE t.kind = 'channel' ORDER BY t.name`,
      )
      .all(me.id)
      .map((r: any) => ({ name: r.name, topic: r.topic, members: r.members, joined: !!r.joined }));
  }

  // --- messages ---

  /** Stores a message and fans it out to every other member. Returns recipients' ids. */
  post(me: Agent, thread: Thread, body: string, replyTo: number | null = null): { message: MessageRow; recipients: number[] } {
    if (!body.trim()) throw new RechError(400, "message is empty");
    const since = new Date(Date.now() - 60_000).toISOString();
    const sent = (this.db.prepare("SELECT count(*) AS n FROM messages WHERE sender_id = ? AND created_at > ?").get(me.id, since) as any).n;
    if (sent >= this.messagesPerMinute) {
      throw new RechError(429, `@${me.handle} sent ${sent} messages in the last minute — slow down (limit ${this.messagesPerMinute}/min)`);
    }
    if (Buffer.byteLength(body) > MAX_BODY) throw new RechError(413, `message is larger than ${MAX_BODY} bytes`);
    if (replyTo !== null) {
      const parent = this.db.prepare("SELECT thread_id FROM messages WHERE id = ?").get(replyTo) as any;
      if (!parent || parent.thread_id !== thread.id) {
        throw new RechError(400, `reply_to #${replyTo} is not a message in this conversation`);
      }
    }
    return this.tx(() => {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO messages (thread_id, sender_id, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(thread.id, me.id, body, replyTo, now());
      const id = Number(lastInsertRowid);
      const recipients = (
        this.db.prepare("SELECT agent_id FROM members WHERE thread_id = ? AND agent_id != ?").all(thread.id, me.id) as any[]
      ).map((r) => r.agent_id as number);
      const deliver = this.db.prepare("INSERT INTO deliveries (message_id, agent_id) VALUES (?, ?)");
      for (const agentId of recipients) deliver.run(id, agentId);
      return { message: this.message(id)!, recipients };
    });
  }

  message(id: number): MessageRow | undefined {
    return this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
  }

  unread(agentId: number, limit = 50): MessageRow[] {
    return this.db
      .prepare(
        `${MESSAGE_SELECT}
         JOIN deliveries d ON d.message_id = m.id
         WHERE d.agent_id = ? AND d.read_at IS NULL
         ORDER BY m.id LIMIT ?`,
      )
      .all(agentId, limit) as unknown as MessageRow[];
  }

  unreadCount(agentId: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM deliveries WHERE agent_id = ? AND read_at IS NULL").get(agentId) as any).n;
  }

  markRead(agentId: number, messageIds: number[]) {
    const stmt = this.db.prepare("UPDATE deliveries SET read_at = ? WHERE agent_id = ? AND message_id = ? AND read_at IS NULL");
    const ts = now();
    this.tx(() => {
      for (const id of messageIds) stmt.run(ts, agentId, id);
    });
  }

  /**
   * Finds the answer to `askId` delivered to `agentId`: in a DM any later message from the
   * other side counts, in a channel only an explicit reply_to does.
   */
  findReply(agentId: number, thread: Thread, askId: number): MessageRow | undefined {
    const condition = thread.kind === "dm" ? "m.id > ?" : "m.reply_to = ?";
    return this.db
      .prepare(
        `${MESSAGE_SELECT}
         JOIN deliveries d ON d.message_id = m.id AND d.agent_id = ?
         WHERE m.thread_id = ? AND ${condition}
         ORDER BY m.id LIMIT 1`,
      )
      .get(agentId, thread.id, askId) as MessageRow | undefined;
  }

  history(thread: Thread, limit = 30): MessageRow[] {
    const rows = this.db
      .prepare(`${MESSAGE_SELECT} WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT ?`)
      .all(thread.id, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  /** Everything, for the human-facing admin feed. */
  feed(afterId = 0, limit = 200): MessageRow[] {
    return this.db
      .prepare(`${MESSAGE_SELECT} WHERE m.id > ? ORDER BY m.id LIMIT ?`)
      .all(afterId, limit) as unknown as MessageRow[];
  }
}
