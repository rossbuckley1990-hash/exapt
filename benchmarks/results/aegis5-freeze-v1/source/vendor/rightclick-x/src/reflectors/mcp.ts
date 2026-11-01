// Remote MCP servers (Streamable HTTP) -> typed capabilities.
// RightClick X is itself an MCP server, so absorbing other MCP servers means
// one connection gives an agent every tool behind every server it learned.

import { inferType } from "../core/semantics.ts";
import type { Capability, Port, Reflection, Risk } from "../core/types.ts";
import { bodyChunks, cancelBody, DISCOVERY_BODY_LIMIT, isEventStream, readText, refuseDeniedResponse, request, slug, type Net } from "./net.ts";

const PROTOCOL = "2025-06-18";

class McpHttpError extends Error {
  readonly status: number;
  constructor(method: string, status: number, detail: string) {
    super(`MCP ${method} -> HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

export class McpClient {
  private session: string | null = null;
  private ready: Promise<any> | null = null;
  private id = 0;
  serverInfo: { name?: string; version?: string } = {};
  private endpoint: string;
  private net: Net;

  constructor(endpoint: string, net: Net) {
    this.endpoint = endpoint;
    this.net = net;
  }

  private async rpc(method: string, params?: unknown, notify = false, owner?: Net["execution"]): Promise<any> {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.id, method, params };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await request({ ...this.net, execution: owner }, this.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    refuseDeniedResponse(res);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (notify) {
      cancelBody(res);
      return null;
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await readText(res, DISCOVERY_BODY_LIMIT)).slice(0, 200); }
      catch { cancelBody(res); }
      throw new McpHttpError(method, res.status, detail);
    }
    const msg = await parseRpcResponse(res, (body as { id: number }).id, method === "tools/call" ? Infinity : DISCOVERY_BODY_LIMIT);
    if (msg.error) throw new Error(`MCP ${method} error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  }

  async init(owner?: Net["execution"]): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.rpc("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "rightclick-x", version: "0.1.0" },
      }, false, owner);
      this.serverInfo = r?.serverInfo ?? {};
      await this.rpc("notifications/initialized", undefined, true, owner);
      return r;
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    await this.ready;
  }

  async listTools(): Promise<any[]> {
    await this.init();
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(r?.tools)) throw new Error("MCP tools/list returned no tools array");
      tools.push(...r.tools);
      cursor = r?.nextCursor;
    } while (cursor && tools.length < 2000);
    return tools;
  }

  /**
   * Returns structured content when the caller wants it (tool has an output schema), else the text.
   * Session recovery resends the call, so the caller must explicitly establish retry safety.
   */
  async call(name: string, args: Record<string, unknown>, structured = true, retrySafe = false, owner?: Net["execution"]): Promise<unknown> {
    await this.init(owner);
    let r: any;
    try {
      r = await this.rpc("tools/call", { name, arguments: args }, false, owner);
    } catch (e) {
      // A status or provider-controlled error message does not prove a write never committed.
      if (!retrySafe || !(e instanceof McpHttpError) || ![400, 404].includes(e.status)) throw e;
      this.session = null;
      this.ready = null;
      await this.init(owner);
      r = await this.rpc("tools/call", { name, arguments: args }, false, owner);
    }
    const text = (r?.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (r?.isError) throw new Error(text || "MCP tool reported an error");
    return structured && r?.structuredContent !== undefined ? r.structuredContent : text;
  }
}

async function parseRpcResponse(res: Response, id: number, maxBytes: number): Promise<any> {
  const isResponse = (msg: any) => msg?.jsonrpc === "2.0" && msg.id === id && ("result" in msg || "error" in msg);
  if (!isEventStream(res)) {
    const msg = JSON.parse(await readText(res, maxBytes));
    if (!isResponse(msg)) throw new Error("MCP response did not match the request");
    return msg;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let skipLF = false;
  const parseLines = () => {
    while (true) {
      // CR is itself a separator. Suppress only its optional following LF,
      // including when CRLF is split across transport chunks.
      if (skipLF) {
        if (!buffer) return;
        if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        skipLF = false;
      }
      const end = buffer.search(/[\r\n]/);
      if (end < 0) return;
      const line = buffer.slice(0, end);
      skipLF = buffer[end] === "\r";
      buffer = buffer.slice(end + 1);
      if (line === "") {
        const text = data.join("\n");
        data = [];
        if (!text) continue;
        const msg = JSON.parse(text);
        if (isResponse(msg)) return msg;
      } else if (line === "data") data.push("");
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  };
  for await (const chunk of bodyChunks(res, maxBytes)) {
    buffer += decoder.decode(chunk, { stream: true });
    const msg = parseLines();
    // Returning closes the reader, without waiting for the provider to close its stream.
    if (msg) return msg;
  }
  // Preserve finite-response handling when the final event has no trailing blank line.
  buffer += decoder.decode() + "\n\n";
  const msg = parseLines();
  if (msg) return msg;
  throw new Error("MCP stream ended without a response");
}

export function reflectMcpTools(tools: any[], endpoint: string, serverName?: string): Reflection {
  const host = new URL(endpoint).host;
  const title = serverName || `MCP ${host}`;
  const providerId = `mcp:${slug(serverName || host + new URL(endpoint).pathname)}`;
  const capabilities: Capability[] = tools.map((t) => {
    const props: Record<string, any> = t.inputSchema?.properties ?? {};
    const req = new Set<string>(t.inputSchema?.required ?? []);
    const inputs: Port[] = Object.entries(props).map(([name, s]) => ({
      ...(Array.isArray(s?.enum) ? { enum: s.enum.map(String) } : {}),
      name,
      type: inferType(name, s, s?.description ?? ""),
      required: req.has(name),
      description: s?.description,
      wire: s?.type,
    }));
    const outputs: Port[] = [];
    const os = t.outputSchema;
    if (os?.properties) {
      outputs.push({ name: "", type: "json", required: true });
      for (const [name, s] of Object.entries<any>(os.properties)) {
        outputs.push({ name, type: inferType(name, s, s?.description ?? ""), required: true, wire: s?.type });
        // One level of nesting, as the OpenAPI and GraphQL reflectors do ({ result: { rate } }).
        for (const [sub, ss] of Object.entries<any>(s?.properties ?? {}).slice(0, 12)) {
          outputs.push({ name: `${name}.${sub}`, type: inferType(sub, ss, ss?.description ?? ""), required: true, wire: ss?.type });
        }
      }
    } else {
      outputs.push({ name: "", type: "text", required: true });
    }
    const a = t.annotations ?? {};
    // MCP's defaults: a tool not marked read-only may be destructive unless it says otherwise.
    // Unknown side effects are treated as the most dangerous kind, not the most convenient.
    // Preserve main's destructive-hint precedence, including malformed truthy annotations.
    const risk: Risk = a.destructiveHint ? "destructive" : a.readOnlyHint === true ? "read" : a.destructiveHint === false ? (a.openWorldHint === false ? "write" : "external") : "destructive";
    return {
      id: `${providerId}:${slug(t.name)}`,
      title: t.title ?? a.title ?? t.name,
      description: String(t.description ?? "").slice(0, 400),
      provider: providerId,
      source: "mcp",
      inputs,
      outputs,
      risk,
      tags: ["mcp", host, t.name],
      invoke: { kind: "mcp", endpoint, tool: t.name },
    };
  });
  return {
    provider: {
      id: providerId,
      title,
      source: "mcp",
      origin: endpoint,
      learnedAt: new Date().toISOString(),
      capabilityIds: capabilities.map((c) => c.id),
    },
    capabilities,
  };
}
