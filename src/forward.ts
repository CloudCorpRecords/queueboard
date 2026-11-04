/**
 * queueboard core: a forwarding client for the hosted
 * FeatureJet MCP server.
 *
 * This package holds no board state locally. The tool
 * surface served for tools/list comes from the literal
 * definitions below, reproduced exactly as captured from
 * the upstream server (each entry carries name,
 * description and inputSchema, and nothing else). A
 * tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header
 * forward when the upstream issues one. The session is
 * opened lazily on the first forwarded call and kept for
 * the rest of the client's life.
 *
 * The upstream endpoint is pinned to
 * https://mcp.featurejet.com/mcp and can be overridden
 * with the FEATUREJET_MCP_URL environment variable (that
 * override is a labelled reconstruction). When
 * FEATUREJET_API_KEY is set in the environment, every
 * upstream request carries `Authorization: Bearer <key>`
 * (also a labelled reconstruction - the capture itself
 * was taken keyless); otherwise no auth header is sent.
 *
 * Upstream results pass through verbatim, including any
 * isError flag and any extra result fields. Failures - a
 * JSON-RPC error from the upstream, a non-2xx status, an
 * unparseable response, or a fetch that throws or times
 * out - surface as an isError result whose text starts
 * with `queueboard error:` (that rendering is a labelled
 * reconstruction). Responses may be plain JSON or SSE
 * (data: lines); the JSON-RPC message with the matching
 * id wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://mcp.featurejet.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/featurejet-tools-original.json)         */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "list_boards",
    "description": "List boards available to the caller's FeatureJet API key.",
    "inputSchema": {
      "properties": {},
      "title": "list_boardsArguments",
      "type": "object"
    }
  },
  {
    "name": "get_board",
    "description": "Get one board by slug.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        }
      },
      "required": [
        "slug"
      ],
      "title": "get_boardArguments",
      "type": "object"
    }
  },
  {
    "name": "create_board",
    "description": "Create a new feedback board, as a DRAFT.\n\n        `slug` is the board's URL path segment (lowercase, hyphenated, unique);\n        `name` is the display name. The new board's public URL 404s until a\n        human publishes it from the dashboard -- `publish_board` is off by\n        default (403 `publish_disabled`).\n        ",
    "inputSchema": {
      "properties": {
        "name": {
          "title": "Name",
          "type": "string",
          "description": "Display name for the new board."
        },
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "URL path segment for the new board (lowercase, hyphenated, unique)."
        },
        "description": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Description",
          "description": "Text description of the new board."
        }
      },
      "required": [
        "name",
        "slug"
      ],
      "title": "create_boardArguments",
      "type": "object"
    }
  },
  {
    "name": "publish_board",
    "description": "Publish a board so it is live at its public URL.\n\n        OFF BY DEFAULT. Putting a board on the public internet is a human\n        decision: unless the FeatureJet deployment has opted in, this returns\n        403 `publish_disabled` and the owner publishes from the dashboard.\n        Where it is enabled it needs a `write` (or `admin`) scoped key and an\n        active subscription -- an org without one gets 403\n        `subscription_required`.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        }
      },
      "required": [
        "slug"
      ],
      "title": "publish_boardArguments",
      "type": "object"
    }
  },
  {
    "name": "unpublish_board",
    "description": "Return a board to draft so its public URL stops serving it.\n\n        Nothing is deleted; publish it again to bring it back.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        }
      },
      "required": [
        "slug"
      ],
      "title": "unpublish_boardArguments",
      "type": "object"
    }
  },
  {
    "name": "list_posts",
    "description": "List posts for a board, optionally filtered by status, search, or tag.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "status": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Status",
          "description": "Filter posts by status."
        },
        "q": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Q",
          "description": "Free-text search query matched against posts."
        },
        "tag": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Tag",
          "description": "Filter posts by this tag."
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Limit",
          "description": "Maximum number of posts to return."
        },
        "offset": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Offset",
          "description": "Number of posts to skip before returning results (paging)."
        }
      },
      "required": [
        "slug"
      ],
      "title": "list_postsArguments",
      "type": "object"
    }
  },
  {
    "name": "get_post",
    "description": "Get one post by board slug and post id.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "get_postArguments",
      "type": "object"
    }
  },
  {
    "name": "create_post",
    "description": "Create a post on a board.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "title": {
          "title": "Title",
          "type": "string",
          "description": "Title of the new post."
        },
        "body": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Body",
          "description": "Body text of the post."
        },
        "status": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Status",
          "description": "Initial status of the post."
        },
        "tags": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Tags",
          "description": "Tags to attach to the post."
        }
      },
      "required": [
        "slug",
        "title"
      ],
      "title": "create_postArguments",
      "type": "object"
    }
  },
  {
    "name": "update_post",
    "description": "Update mutable post fields; null queue_rank explicitly un-ranks.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        },
        "title": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Title",
          "description": "New title for the post."
        },
        "body": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Body",
          "description": "New body text for the post."
        },
        "status": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Status",
          "description": "New status for the post."
        },
        "tags": {
          "anyOf": [
            {
              "items": {
                "type": "string"
              },
              "type": "array"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Tags",
          "description": "Replacement tags for the post."
        },
        "pinned": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Pinned",
          "description": "Whether the post is pinned."
        },
        "queue_rank": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "title": "Queue Rank",
          "description": "Owner-curated queue position (lower = sooner); null explicitly un-ranks the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "update_postArguments",
      "type": "object"
    }
  },
  {
    "name": "delete_post",
    "description": "Delete a post by hiding it through the developer API.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "delete_postArguments",
      "type": "object"
    }
  },
  {
    "name": "list_votes",
    "description": "List vote metadata for a post.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "list_votesArguments",
      "type": "object"
    }
  },
  {
    "name": "list_comments",
    "description": "List comments for a post.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "list_commentsArguments",
      "type": "object"
    }
  },
  {
    "name": "create_comment",
    "description": "Comment on a post as the board team, optionally replying to a comment.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        },
        "body": {
          "title": "Body",
          "type": "string",
          "description": "Text of the comment."
        },
        "parent_comment_id": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Parent Comment Id",
          "description": "Id of the comment being replied to, when this comment is a reply."
        }
      },
      "required": [
        "slug",
        "post_id",
        "body"
      ],
      "title": "create_commentArguments",
      "type": "object"
    }
  },
  {
    "name": "get_queue",
    "description": "Top UNCLAIMED posts in the owner's curated build order.\n\n        Owner-ranked posts (queue_rank, lower = sooner) come first, then\n        unranked planned posts by votes. Call this to find the next thing to\n        build, then claim_post before starting work.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "limit": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Limit",
          "description": "Maximum number of queued posts to return."
        }
      },
      "required": [
        "slug"
      ],
      "title": "get_queueArguments",
      "type": "object"
    }
  },
  {
    "name": "claim_post",
    "description": "Atomically claim a post before working on it (double-work guard).\n\n        ttl_seconds defaults to 3600 (max 86400); re-claiming with the same\n        key extends the lease. Returns 409 if another key holds a live claim.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        },
        "ttl_seconds": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Ttl Seconds",
          "description": "Claim lifetime in seconds (defaults to 3600, max 86400)."
        },
        "agent_label": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Agent Label",
          "description": "Label identifying the claiming agent."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "claim_postArguments",
      "type": "object"
    }
  },
  {
    "name": "release_post",
    "description": "Release a post's claim so other agents can pick it up.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        }
      },
      "required": [
        "slug",
        "post_id"
      ],
      "title": "release_postArguments",
      "type": "object"
    }
  },
  {
    "name": "add_evidence",
    "description": "Attach implementation evidence to a post (shown publicly).\n\n        kind is one of branch|commit|pr|transcript|url; ref is the branch\n        name, commit sha, or URL. Voters see these in the post page's\n        \"Implementation\" section.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        },
        "kind": {
          "title": "Kind",
          "type": "string",
          "description": "Kind of evidence: one of branch, commit, pr, transcript or url."
        },
        "ref": {
          "title": "Ref",
          "type": "string",
          "description": "The evidence reference itself: branch name, commit hash, PR reference, transcript id or URL, according to kind."
        },
        "label": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Label",
          "description": "Short label shown with the evidence."
        },
        "action_key": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Action Key",
          "description": "Optional key identifying the agent action this evidence belongs to."
        }
      },
      "required": [
        "slug",
        "post_id",
        "kind",
        "ref"
      ],
      "title": "add_evidenceArguments",
      "type": "object"
    }
  },
  {
    "name": "propose_status",
    "description": "Propose a status change for the board owner to confirm.\n\n        The agent-honest way to mark work done: nothing changes on the\n        public board and no voter is notified until a human confirms the\n        proposal from the dashboard. status is one of\n        open|planned|in_progress|shipped|declined; a new proposal replaces\n        any pending one. Prefer this over update_post's direct status flip.\n        ",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "post_id": {
          "title": "Post Id",
          "type": "integer",
          "description": "Numeric id of the post."
        },
        "status": {
          "title": "Status",
          "type": "string",
          "description": "The status being proposed for the post."
        },
        "note": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Note",
          "description": "Note explaining the proposed status change."
        },
        "action_key": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Action Key",
          "description": "Optional key identifying the agent action behind this proposal."
        }
      },
      "required": [
        "slug",
        "post_id",
        "status"
      ],
      "title": "propose_statusArguments",
      "type": "object"
    }
  },
  {
    "name": "get_changelog",
    "description": "List shipped posts for a board.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        }
      },
      "required": [
        "slug"
      ],
      "title": "get_changelogArguments",
      "type": "object"
    }
  },
  {
    "name": "get_analytics",
    "description": "Get read-only analytics for a board.",
    "inputSchema": {
      "properties": {
        "slug": {
          "title": "Slug",
          "type": "string",
          "description": "Slug of the board (its URL path segment)."
        },
        "period": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ],
          "default": null,
          "title": "Period",
          "description": "Analytics period to report over."
        }
      },
      "required": [
        "slug"
      ],
      "title": "get_analyticsArguments",
      "type": "object"
    }
  },
  {
    "name": "whoami",
    "description": "Confirm the caller's API key by listing accessible boards.",
    "inputSchema": {
      "properties": {},
      "title": "whoamiArguments",
      "type": "object"
    }
  },
  {
    "name": "ping",
    "description": "Check MCP and FeatureJet API reachability for the caller's key.",
    "inputSchema": {
      "properties": {},
      "title": "pingArguments",
      "type": "object"
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` is one of the captured tools. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `queueboard error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Parse a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * one is present, else the last parseable message, else
 * null when nothing parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not JSON; ignore this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding one upstream session. The
 * session is established lazily on the first forwarded
 * call and reused for the lifetime of the client (the
 * process lifetime when the client is the MCP server's
 * or a one-shot client for the CLI).
 */
export class QueueboardClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).FEATUREJET_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).FEATUREJET_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "queueboard", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // The notification response body carries nothing we need.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Pass the upstream result through verbatim.
    return result;
  }
}

/** Create a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): QueueboardClient {
  return new QueueboardClient(deps);
}

/** One-shot helper: a fresh client per call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new QueueboardClient(deps).callTool(name, args);
}
