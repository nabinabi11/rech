// Wires RECH into whatever agents the person uses, in their native way,
// without touching files that get committed to the repo.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const node = process.execPath.replaceAll("\\", "/");
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url)).replaceAll("\\", "/");
/** How other programs start rech: absolute paths, so it works without PATH or npx. */
export const rechCommand = [node, cli];
const hookCommand = (kind: string) => `"${node}" "${cli}" hook ${kind}`;

const readJson = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const writeJson = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

// Agent CLIs are .cmd shims on Windows, which only run through a shell,
// so the command line is assembled here with every argument quoted.
const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);

function run(command: string, args: string[], cwd: string) {
  return execSync([command, ...args].map(quote).join(" "), { cwd, stdio: "pipe", timeout: 30000 }).toString();
}

function has(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export function ensureGitignored(dir: string, name: string) {
  if (!existsSync(join(dir, ".git")) && !existsSync(join(dir, ".gitignore"))) return;
  const file = join(dir, ".gitignore");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (!lines.includes(name)) appendFileSync(file, `${lines.length && lines.at(-1) !== "" ? "\n" : ""}${name}\n`);
}

/** Adds our hook unless a RECH hook for that event is already there. */
function addHook(settings: any, event: string, command: string) {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const present = settings.hooks[event].some((group: any) => group.hooks?.some((h: any) => h.command?.includes(cli)));
  if (!present) settings.hooks[event].push({ hooks: [{ type: "command", command }] });
}

function claudeCode(cwd: string): string {
  // Local scope: private to this person and this project, stored outside the repo.
  try {
    run("claude", ["mcp", "remove", "rech", "-s", "local"], cwd);
  } catch {
    // was not there
  }
  run("claude", ["mcp", "add", "rech", "-s", "local", "--", ...rechCommand, "mcp"], cwd);

  // Hooks: the agent hears about new messages on every prompt and before it stops.
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  const file = join(cwd, ".claude", "settings.local.json");
  const settings = readJson(file);
  addHook(settings, "SessionStart", hookCommand("prompt"));
  addHook(settings, "UserPromptSubmit", hookCommand("prompt"));
  addHook(settings, "Stop", hookCommand("stop"));
  writeJson(file, settings);
  return "Claude Code — MCP server (local scope) + hooks in .claude/settings.local.json";
}

function codex(cwd: string): string {
  // Codex keeps MCP servers globally; the identity is still per project via .rech.json.
  const config = join(homedir(), ".codex", "config.toml");
  if (existsSync(config) && /^\[mcp_servers\.rech\]/m.test(readFileSync(config, "utf8"))) {
    return "Codex — already has the rech MCP server";
  }
  run("codex", ["mcp", "add", "rech", "--", ...rechCommand, "mcp"], cwd);
  return "Codex — MCP server added to ~/.codex/config.toml";
}

function cursor(cwd: string): string {
  const file = join(cwd, ".cursor", "mcp.json");
  const config = readJson(file);
  config.mcpServers ??= {};
  config.mcpServers.rech = { command: rechCommand[0], args: [rechCommand[1], "mcp"] };
  writeJson(file, config);
  return "Cursor — .cursor/mcp.json";
}

/** Connects every agent found on this machine/project. Returns a line per agent for the summary. */
export function wireAgents(cwd: string, only?: string[]): string[] {
  const targets: [string, () => boolean, (cwd: string) => string][] = [
    ["claude", () => has("claude"), claudeCode],
    ["codex", () => has("codex"), codex],
    ["cursor", () => existsSync(join(cwd, ".cursor")), cursor],
  ];
  const done: string[] = [];
  for (const [name, detect, wire] of targets) {
    if (only ? !only.includes(name) : !detect()) continue;
    try {
      done.push(wire(cwd));
    } catch (e) {
      done.push(`${name} — failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return done;
}
