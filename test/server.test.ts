import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/server/store.ts";
import { createApp } from "../src/server/app.ts";

const ADMIN = "admin-secret";
const app = createApp(new Store(":memory:"), ADMIN);
let base = "";
const tokens: Record<string, string> = {};

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

before(async () => {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  for (const [handle, owner] of [["front", "Nabi"], ["back", "Arman"], ["ops", "Arman"]]) {
    const { status, data } = await call(ADMIN, "POST", "/v1/admin/agents", { handle, owner, description: `${handle} repo` });
    assert.equal(status, 201);
    tokens[handle] = data.token;
  }
});

after(() => {
  app.closeAllConnections();
  app.close();
});

test("rejects bad tokens and duplicate handles", async () => {
  assert.equal((await call("nope", "GET", "/v1/me")).status, 401);
  assert.equal((await call(tokens.front, "POST", "/v1/admin/agents", { handle: "x1", owner: "a" })).status, 401);
  assert.equal((await call(ADMIN, "POST", "/v1/admin/agents", { handle: "front", owner: "a" })).status, 409);
  assert.equal((await call(ADMIN, "POST", "/v1/admin/agents", { handle: "Bad Handle", owner: "a" })).status, 400);
});

test("direct message lands in the recipient inbox exactly once", async () => {
  const sent = await call(tokens.front, "POST", "/v1/messages", { to: "@back", body: "what does GET /orders return?" });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.to, "@back");

  const inbox = await call(tokens.back, "GET", "/v1/inbox");
  assert.equal(inbox.data.messages.length, 1);
  assert.equal(inbox.data.messages[0].from, "front");
  assert.equal(inbox.data.messages[0].reply_address, "@front");
  assert.equal((await call(tokens.back, "GET", "/v1/inbox")).data.messages.length, 0);
  assert.equal((await call(tokens.front, "GET", "/v1/inbox")).data.messages.length, 0, "sender gets no copy");
});

test("peek does not consume messages", async () => {
  await call(tokens.front, "POST", "/v1/messages", { to: "@ops", body: "ping" });
  const peeked = await call(tokens.ops, "GET", "/v1/inbox?peek=1");
  assert.equal(peeked.data.messages.length, 1);
  assert.equal(peeked.data.remaining, 0);
  assert.equal((await call(tokens.ops, "GET", "/v1/inbox")).data.messages.length, 1);
  assert.equal((await call(tokens.ops, "GET", "/v1/me")).data.unread, 0);
});

test("long-poll wakes up when a message arrives", async () => {
  const started = Date.now();
  const waiting = call(tokens.back, "GET", "/v1/inbox?wait=10");
  setTimeout(() => call(tokens.front, "POST", "/v1/messages", { to: "@back", body: "are you there?" }), 200);
  const { data } = await waiting;
  assert.equal(data.messages[0].body, "are you there?");
  assert.ok(Date.now() - started < 5000);
});

test("ask waits for the answer from the other agent", async () => {
  const asking = call(tokens.front, "POST", "/v1/ask", { to: "@back", body: "is `total` in cents?", timeout: 10 });
  const { data: inbox } = await call(tokens.back, "GET", "/v1/inbox?wait=5");
  const question = inbox.messages.at(-1);
  await call(tokens.back, "POST", "/v1/messages", { to: question.reply_address, body: "yes, integer cents", reply_to: question.id });

  const { data } = await asking;
  assert.equal(data.reply.body, "yes, integer cents");
  assert.equal(data.reply.reply_to, data.question.id);
  assert.equal((await call(tokens.front, "GET", "/v1/inbox")).data.messages.length, 0, "the answer is consumed by ask");
});

test("ask times out with reply null when nobody answers", async () => {
  const { data } = await call(tokens.front, "POST", "/v1/ask", { to: "@ops", body: "anyone?", timeout: 0.3 });
  assert.equal(data.reply, null);
  await call(tokens.ops, "GET", "/v1/inbox");
});

test("channels: create with invites, post, join, membership checks", async () => {
  const created = await call(tokens.front, "POST", "/v1/channels", { name: "payments", topic: "Kaspi integration", invite: ["@back"] });
  assert.equal(created.status, 201);
  const announce = await call(tokens.back, "GET", "/v1/inbox");
  assert.match(announce.data.messages[0].body, /created #payments/);

  assert.equal((await call(tokens.ops, "POST", "/v1/messages", { to: "#payments", body: "hi" })).status, 403);
  assert.equal((await call(tokens.ops, "POST", "/v1/channels/payments/join")).status, 200);
  await call(tokens.ops, "POST", "/v1/messages", { to: "#payments", body: "webhook is ready" });

  for (const who of ["front", "back"]) {
    const [m] = (await call(tokens[who], "GET", "/v1/inbox")).data.messages;
    assert.equal(m.body, "webhook is ready");
    assert.equal(m.reply_address, "#payments");
  }
  const { data } = await call(tokens.back, "GET", "/v1/channels");
  assert.deepEqual(data.channels, [{ name: "payments", topic: "Kaspi integration", members: 3, joined: true }]);
});

test("reply_to must belong to the same conversation", async () => {
  const { data } = await call(tokens.front, "POST", "/v1/messages", { to: "@back", body: "q" });
  const res = await call(tokens.ops, "POST", "/v1/messages", { to: "@back", body: "a", reply_to: data.message.id });
  assert.equal(res.status, 400);
});

test("admin feed shows every conversation", async () => {
  const { data } = await call(ADMIN, "GET", "/v1/admin/feed");
  assert.ok(data.messages.some((m: any) => m.to === "#payments"));
  assert.ok(data.messages.some((m: any) => m.to === "@back" && m.from === "front"));
});

test("invite: self-service join, wrong code rejected, rotation revokes the old link", async () => {
  const store = new Store(":memory:");
  const code = store.ensureSetting("invite", () => "team-code");
  assert.equal(store.ensureSetting("invite", () => "other"), code, "invite is stable across restarts");
  assert.throws(() => store.join("wrong", "x1", "X"), /invite is invalid/);
  assert.equal(store.join("team-code", "x1", "X").agent.handle, "x1");
  store.rotateInvite();
  assert.throws(() => store.join("team-code", "x2", "X"), /invite is invalid/);
});

test("join over HTTP and the invite page", async () => {
  const store = new Store(":memory:");
  const code = store.rotateInvite();
  const server = createApp(store, "adm");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await (await fetch(`${url}/join/${code}`)).text();
    assert.ok(page.includes(`rech join ${url}/join/${code}`));
    const res = await fetch(`${url}/v1/join`, {
      method: "POST",
      body: JSON.stringify({ invite: code, handle: "newbie", owner: "Max" }),
    });
    assert.equal(res.status, 201);
    const { token } = (await res.json()) as any;
    const me = await (await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal((me as any).handle, "newbie");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("ack marks only the handled messages read", async () => {
  await call(tokens.front, "POST", "/v1/messages", { to: "@ops", body: "one" });
  await call(tokens.front, "POST", "/v1/messages", { to: "@ops", body: "two" });
  const { data } = await call(tokens.ops, "GET", "/v1/inbox?peek=1");
  assert.equal(data.messages.length, 2);
  const ack = await call(tokens.ops, "POST", "/v1/inbox/ack", { ids: [data.messages[0].id] });
  assert.equal(ack.data.unread, 1);
  assert.equal((await call(tokens.ops, "GET", "/v1/inbox")).data.messages[0].body, "two");
  assert.equal((await call(tokens.ops, "POST", "/v1/inbox/ack", { ids: ["x"] })).status, 400);
});

test("rate limit stops a runaway agent", async () => {
  const store = new Store(":memory:", { messagesPerMinute: 3 });
  const a = store.createAgent("loop-a", "A").agent;
  store.createAgent("loop-b", "B");
  const thread = store.resolveAddress(a, "@loop-b");
  for (let i = 0; i < 3; i++) store.post(a, thread, `msg ${i}`);
  assert.throws(() => store.post(a, thread, "one too many"), /slow down/);
});

test("admin removes an agent: token dies, handle is free, mail to it stops", async () => {
  const { data: created } = await call(ADMIN, "POST", "/v1/admin/agents", { handle: "leaver", owner: "Ex" });
  assert.equal((await call(created.token, "GET", "/v1/me")).status, 200);
  assert.equal((await call(tokens.front, "DELETE", "/v1/admin/agents/leaver")).status, 401, "agents cannot remove agents");

  const removed = await call(ADMIN, "DELETE", "/v1/admin/agents/leaver");
  assert.equal(removed.data.removed, "leaver");
  assert.equal((await call(created.token, "GET", "/v1/me")).status, 401);
  assert.ok(!(await call(tokens.front, "GET", "/v1/agents")).data.agents.some((a: any) => a.handle === "leaver"));
  assert.equal((await call(tokens.front, "POST", "/v1/messages", { to: "@leaver", body: "hi" })).status, 404);
  assert.equal((await call(ADMIN, "POST", "/v1/admin/agents", { handle: "leaver", owner: "New" })).status, 201, "handle reusable");
});

test("server hands out the rech package when configured", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "rech-pkg-")), "rech.tgz");
  writeFileSync(file, "tarball");
  const store = new Store(":memory:");
  const code = store.rotateInvite();
  const server = createApp(store, "adm", { packageFile: file });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await (await fetch(`${url}/rech.tgz`)).text(), "tarball");
    assert.ok((await (await fetch(`${url}/join/${code}`)).text()).includes(`npm install -g ${url}/rech.tgz`));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
