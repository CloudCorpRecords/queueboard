import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  parseRpcBody,
  PROTOCOL_VERSION,
  QueueboardClient,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream
 * implementing the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, no live call - the real
 * mcp.featurejet.com endpoint is never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/featurejet-tools-original.json",
  import.meta.url,
);
const fixture = (
  existsSync(FIXTURE_URL)
    ? (JSON.parse(readFileSync(FIXTURE_URL, "utf-8")) as {
        tools: ToolDef[];
      })
    : null
) as { tools: ToolDef[] } | null;
/** Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (2026-11-04): the served tools carry parameter descriptions
 * added over the original capture; everything else must match exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}


const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"boards\":[],\"count\":0}" }],
  structuredContent: { count: 0 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "featurejet", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new QueueboardClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 22 tools, deep-equal", (t) => {
    if (!fixture) {
      t.skip("parity fixture lives in the build harness, not the repo tree");
      return;
    }
    assert.equal(fixture.tools.length, 22);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 22 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "list_boards",
      "get_board",
      "create_board",
      "publish_board",
      "unpublish_board",
      "list_posts",
      "get_post",
      "create_post",
      "update_post",
      "delete_post",
      "list_votes",
      "list_comments",
      "create_comment",
      "get_queue",
      "claim_post",
      "release_post",
      "add_evidence",
      "propose_status",
      "get_changelog",
      "get_analytics",
      "whoami",
      "ping",
    ]);
  });

  it("carries exactly the fixture's required fields per tool", () => {
    const required = new Map(
      TOOL_DEFS.map((t) => [
        t.name,
        (t.inputSchema as { required?: string[] }).required ?? [],
      ]),
    );
    assert.deepEqual(required.get("list_boards"), []);
    assert.deepEqual(required.get("get_board"), ["slug"]);
    assert.deepEqual(required.get("create_board"), ["name", "slug"]);
    assert.deepEqual(required.get("publish_board"), ["slug"]);
    assert.deepEqual(required.get("unpublish_board"), ["slug"]);
    assert.deepEqual(required.get("list_posts"), ["slug"]);
    assert.deepEqual(required.get("get_post"), ["slug", "post_id"]);
    assert.deepEqual(required.get("create_post"), ["slug", "title"]);
    assert.deepEqual(required.get("update_post"), ["slug", "post_id"]);
    assert.deepEqual(required.get("delete_post"), ["slug", "post_id"]);
    assert.deepEqual(required.get("list_votes"), ["slug", "post_id"]);
    assert.deepEqual(required.get("list_comments"), ["slug", "post_id"]);
    assert.deepEqual(required.get("create_comment"), ["slug", "post_id", "body"]);
    assert.deepEqual(required.get("get_queue"), ["slug"]);
    assert.deepEqual(required.get("claim_post"), ["slug", "post_id"]);
    assert.deepEqual(required.get("release_post"), ["slug", "post_id"]);
    assert.deepEqual(required.get("add_evidence"), ["slug", "post_id", "kind", "ref"]);
    assert.deepEqual(required.get("propose_status"), ["slug", "post_id", "status"]);
    assert.deepEqual(required.get("get_changelog"), ["slug"]);
    assert.deepEqual(required.get("get_analytics"), ["slug"]);
    assert.deepEqual(required.get("whoami"), []);
    assert.deepEqual(required.get("ping"), []);
  });

  it("serves no title key on any tool definition", () => {
    for (const t of TOOL_DEFS) {
      assert.deepEqual(Object.keys(t).sort(), ["description", "inputSchema", "name"]);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://mcp.featurejet.com/mcp");

    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, {
      name: "queueboard",
      version: VERSION,
    });
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(
        call.headers["Accept"],
        "application/json, text/event-stream",
      );
    }
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("list_boards", {});
    await c.callTool("whoami", {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool("whoami", {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the FEATUREJET_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new QueueboardClient({
      fetchFn: upstream.fetchFn,
      env: { FEATUREJET_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool("whoami", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool("whoami", {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("upstream auth header", () => {
  it("sends Authorization: Bearer <key> on every request when FEATUREJET_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new QueueboardClient({
      fetchFn: upstream.fetchFn,
      env: { FEATUREJET_API_KEY: "fj-test-key" },
    });
    await c.callTool("list_boards", {});
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer fj-test-key",
      ),
    );
  });

  it("sends no Authorization header when FEATUREJET_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("list_boards", {});
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards get_board with its slug verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("get_board", { slug: "ideas" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "get_board");
    assert.deepEqual(params.arguments, { slug: "ideas" });
  });

  it("forwards create_board with name, slug and description", async () => {
    const { client: c, calls } = stubClient();
    const args = { name: "Ideas", slug: "ideas", description: "Tell us" };
    await c.callTool("create_board", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "create_board");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards create_post with slug, title and tags", async () => {
    const { client: c, calls } = stubClient();
    const args = { slug: "ideas", title: "Dark mode", tags: ["ui"] };
    await c.callTool("create_post", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "create_post");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards claim_post with slug, post_id and ttl", async () => {
    const { client: c, calls } = stubClient();
    const args = { slug: "ideas", post_id: 42, ttl_seconds: 7200 };
    await c.callTool("claim_post", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "claim_post");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards add_evidence with kind and ref", async () => {
    const { client: c, calls } = stubClient();
    const args = { slug: "ideas", post_id: 42, kind: "pr", ref: "https://example.com/pr/1" };
    await c.callTool("add_evidence", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "add_evidence");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards propose_status with its status", async () => {
    const { client: c, calls } = stubClient();
    const args = { slug: "ideas", post_id: 42, status: "shipped" };
    await c.callTool("propose_status", args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "propose_status");
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a no-argument tool with an empty arguments object", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool("ping", {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "ping");
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool("list_boards", {});
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "board not found" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool("get_board", { slug: "missing" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool("whoami", {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      "get_queue",
      { slug: "ideas", limit: 5 },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, "get_queue");
    assert.deepEqual(params.arguments, { slug: "ideas", limit: 5 });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as queueboard error text", () => {
  it("maps a JSON-RPC error to `queueboard error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "board not found" },
    });
    const out = await c.callTool("get_board", { slug: "missing" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "queueboard error: board not found");
  });

  it("maps an initialize JSON-RPC error to queueboard error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "queueboard error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "queueboard error: malformed response");
  });

  it("maps a non-2xx upstream status to queueboard error text", async () => {
    const { client: c } = stubClient({
      callBodyText: "internal error",
      callStatus: 500,
    });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "queueboard error: HTTP 500");
  });

  it("maps a throwing fetch to queueboard error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^queueboard error: /);
  });

  it("maps a throwing initialize fetch to queueboard error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "queueboard error: socket hang up");
  });

  it("maps a timed-out call to queueboard error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool("list_boards", {});
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^queueboard error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects non-object arguments before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "list_boards", ["nope"]),
      (err: unknown) => err instanceof McpError,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, "create_comment", {
      slug: "ideas",
      post_id: 42,
      body: "On it",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { slug: "ideas", post_id: 42, body: "On it" });
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli(["list_boards", "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli(["list_boards", "[]"]);
    assert.equal(res.status, 2);
  });
});
