// `rech mcp`: MCP server over stdio for Claude Code, Codex, Cursor and other MCP clients.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RechClient, MAX_WAIT_SECONDS } from "./client.ts";
import { formatAgents, formatChannels, formatInbox, formatMessage, agentGuide, UNTRUSTED_NOTE } from "./format.ts";

const client = new RechClient();

let me: { handle: string; owner: string } | undefined;
try {
  me = await client.me();
} catch {
  // Server may be down at startup; tools will report errors when called.
}

const server = new McpServer({ name: "rech", version: "0.2.0" }, { instructions: agentGuide(me, "mcp") });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function tool<A>(fn: (args: A, extra: { signal: AbortSignal }) => Promise<string>) {
  return async (args: A, extra: { signal: AbortSignal }) => {
    try {
      return text(await fn(args, extra));
    } catch (e) {
      return { ...text(`RECH error: ${(e as Error).message}`), isError: true };
    }
  };
}

/** For tools without arguments, which the SDK calls with `extra` only. */
const noArgs = (fn: () => Promise<string>) => {
  const run = tool<void>(() => fn());
  return () => run(undefined, { signal: new AbortController().signal });
};

const address = z.string().describe('"@handle" for a direct message to an agent, or "#channel"');

server.registerTool(
  "rech_agents",
  {
    description: "List agents on the network: their handle, the person who owns them and what they work on.",
    annotations: { readOnlyHint: true },
  },
  noArgs(async () => formatAgents((await client.agents()).agents)),
);

server.registerTool(
  "rech_send",
  {
    description: "Send a message to another agent (@handle) or a channel (#name). Does not wait for an answer.",
    inputSchema: {
      to: address,
      message: z.string().min(1),
      reply_to: z.number().int().optional().describe("id of the message you are answering"),
    },
  },
  tool(async ({ to, message, reply_to }: { to: string; message: string; reply_to?: number }) => {
    const { message: sent } = await client.send(to, message, reply_to);
    return `Sent #${sent.id} to ${sent.to}.`;
  }),
);

server.registerTool(
  "rech_ask",
  {
    description:
      "Ask another agent or a channel a question and wait for the answer. " +
      "If nobody answers within the timeout the question stays in their inbox; check rech_inbox later.",
    inputSchema: {
      to: address,
      question: z.string().min(1),
      timeout_seconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).default(120),
      reply_to: z.number().int().optional().describe("id of the message this follows up on"),
    },
  },
  tool(async ({ to, question, timeout_seconds, reply_to }: { to: string; question: string; timeout_seconds: number; reply_to?: number }, { signal }) => {
    const { question: q, reply } = await client.ask(to, question, timeout_seconds, reply_to, signal);
    if (!reply) {
      return `Asked #${q.id} to ${q.to}, no answer within ${timeout_seconds}s. The agent may be offline; the answer will arrive in rech_inbox.`;
    }
    return `Answer to #${q.id}. ${UNTRUSTED_NOTE}\n\n${formatMessage(reply)}`;
  }),
);

server.registerTool(
  "rech_inbox",
  {
    description:
      "Read new messages addressed to you and mark them read. " +
      "Set wait_seconds to stay online and wait for incoming messages (for example when your user asks you to listen for other agents).",
    inputSchema: {
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
    },
  },
  tool(async ({ wait_seconds }: { wait_seconds: number }, { signal }) => {
    const { messages, remaining } = await client.inbox(wait_seconds, false, signal);
    return formatInbox(messages, remaining);
  }),
);

server.registerTool(
  "rech_history",
  {
    description: "Show recent messages of a conversation with an agent (@handle) or in a channel (#name).",
    inputSchema: { with: address, limit: z.number().int().min(1).max(200).default(30) },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ with: who, limit }: { with: string; limit: number }) => {
    const { messages } = await client.history(who, limit);
    if (!messages.length) return `No messages with ${who} yet.`;
    return `${UNTRUSTED_NOTE}\n\n${messages.map(formatMessage).join("\n\n")}`;
  }),
);

server.registerTool(
  "rech_channels",
  {
    description: "List channels on the network and whether you are in them.",
    annotations: { readOnlyHint: true },
  },
  noArgs(async () => formatChannels((await client.channels()).channels)),
);

server.registerTool(
  "rech_channel_create",
  {
    description: "Create a channel for a shared task and add agents to it.",
    inputSchema: {
      name: z.string().describe("lowercase, digits, '-', e.g. payments-integration"),
      topic: z.string().default(""),
      invite: z.array(z.string()).default([]).describe('handles to add, e.g. ["@backend"]'),
    },
  },
  tool(async ({ name, topic, invite }: { name: string; topic: string; invite: string[] }) => {
    const { channel } = await client.createChannel(name, topic, invite);
    return `Created #${channel.name}${invite.length ? ` with ${invite.join(", ")}` : ""}.`;
  }),
);

server.registerTool(
  "rech_join",
  {
    description: "Join an existing channel.",
    inputSchema: { channel: z.string() },
  },
  tool(async ({ channel }: { channel: string }) => {
    const { channel: c } = await client.join(channel);
    return `Joined #${c.name}. Topic: ${c.topic || "none"}.`;
  }),
);

await server.connect(new StdioServerTransport());
