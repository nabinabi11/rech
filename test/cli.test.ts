// The whole flow as people and agents use it: invite link → `rech join` → CLI messaging → `rech serve`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/server/store.ts";
import { createApp } from "../src/server/app.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const store = new Store(":memory:");
const app = createApp(store, "adm");
const root = mkdtempSync(join(tmpdir(), "rech-cli-"));
const repos = { front: join(root, "front"), vps: join(root, "vps") };
let link = "";
let server: ChildProcess | undefined;

// Agents are wired with --only none so the test never touches the real Claude Code/Codex config.
function rech(cwd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, ...args], { cwd, env: { ...process.env, RECH_URL: "", RECH_TOKEN: "" } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    );
    child.stdin!.end(stdin ?? "");
  });
}

before(async () => {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  link = `http://127.0.0.1:${(app.address() as AddressInfo).port}/join/${store.rotateInvite()}`;
  for (const dir of Object.values(repos)) {
    (await import("node:fs")).mkdirSync(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  }
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once("exit", resolve));
    server.kill();
    await exited;
  }
  app.closeAllConnections();
  app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("rech join registers the project's agent and keeps the token out of git", async () => {
  const out = await rech(repos.front, ["join", link, "--as", "nabi-front", "--owner", "Nabi", "--only", "none"]);
  assert.match(out, /@nabi-front is on/);
  assert.match(readFileSync(join(repos.front, ".gitignore"), "utf8"), /^\.rech\.json$/m);
  await rech(repos.vps, ["join", link, "--as", "nabi-vps", "--owner", "Nabi", "--desc", "deploys on the VPS", "--only", "none"]);

  const again = await rech(repos.front, ["join", link, "--only", "none"]);
  assert.match(again, /@nabi-front is on/, "joining again keeps the identity");
  assert.match(await rech(repos.front, ["agents"]), /@nabi-vps — agent of Nabi; deploys on the VPS/);
});

test("wrong invite is refused", async () => {
  await assert.rejects(rech(root, ["join", link.replace(/[^/]+$/, "nope"), "--as", "x9", "--only", "none"]), /invite is invalid/);
});

test("send from stdin, read inbox", async () => {
  await rech(repos.front, ["send", "@nabi-vps"], "line one\nline two");
  const inbox = await rech(repos.vps, ["inbox"]);
  assert.match(inbox, /from="@nabi-front"[\s\S]*line one\nline two/);
  assert.match(inbox, /rech send <reply_address>/);
});

test("rech serve answers with any command and the asker gets the reply", async () => {
  const fake = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
  server = spawn(process.execPath, [cli, "serve", "--exec", `"${process.execPath}" "${fake}"`], {
    cwd: repos.vps,
    env: { ...process.env, RECH_URL: "", RECH_TOKEN: "" },
  });
  await new Promise((resolve) => server!.stdout!.once("data", resolve)); // "is on the line"

  const answer = await rech(repos.front, ["ask", "@nabi-vps", "render test image", "--timeout", "20"]);
  assert.match(answer, /GPU check passed for: render test image/);

  await rech(repos.front, ["send", "@nabi-vps", "thanks"]);
  await new Promise((r) => setTimeout(r, 1500));
  const history = await rech(repos.front, ["history", "@nabi-vps"]);
  assert.doesNotMatch(history, /GPU check passed for: thanks/, "NO_REPLY sends nothing");
});

test("rech serve retries a failed run instead of losing the message", async () => {
  server?.kill();
  const flaky = fileURLToPath(new URL("./fixtures/flaky-agent.mjs", import.meta.url));
  server = spawn(process.execPath, [cli, "serve", "--exec", `"${process.execPath}" "${flaky}"`], {
    cwd: repos.vps,
    env: { ...process.env, RECH_URL: "", RECH_TOKEN: "", RECH_RETRY_SECONDS: "1" },
  });
  await new Promise((resolve) => server!.stdout!.once("data", resolve));

  const answer = await rech(repos.front, ["ask", "@nabi-vps", "are you there?", "--timeout", "20"]);
  assert.match(answer, /answered on retry/);
});

test("rech admin removes an agent from the server's database", async () => {
  const data = join(root, "net");
  (await import("node:fs")).mkdirSync(data);
  const local = new Store(join(data, "rech.db"));
  local.createAgent("temp-agent", "T");
  const out = await rech(root, ["admin", "remove", "@temp-agent", "--data", data]);
  assert.match(out, /removed @temp-agent/);
  assert.equal(local.agentByHandle("temp-agent"), undefined);
  assert.match(await rech(root, ["admin", "agents", "--data", data]), /no agents yet/);
  local.db.close(); // Windows cannot delete an open database file in after()
});

test("rech prompt gives shell-only agents their instructions", async () => {
  const prompt = await rech(repos.vps, ["prompt"]);
  assert.match(prompt, /You are @nabi-vps, the agent of Nabi/);
  assert.match(prompt, /rech ask @agent/);
});
