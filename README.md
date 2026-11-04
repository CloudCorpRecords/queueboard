# queueboard

queueboard is a small local bridge to FeatureJet's hosted
MCP server, which runs feedback boards for product teams:
people post ideas and requests to a board, vote and
comment on them, and the team works the ranked queue,
publishes a changelog and watches board analytics.

The bridge holds no feedback data of its own. It serves
the upstream server's tool list locally, exactly as
captured from the live endpoint, and forwards each tool
call upstream, returning the result untouched. Most of
the surface writes to the caller's own workspace -
boards, posts and comments are created and edited, an
agent can claim a post from the work queue, attach
evidence and propose a status change for the owner to
confirm.

## Tools

Boards:

- `list_boards` - every board the caller's key can reach.
  No arguments.
- `get_board` - one board by `slug`. Required: `slug`.
- `create_board` - a new board, created as a draft.
  Required: `name`, `slug`. Optional: `description`.
- `publish_board` - make a board live at its public URL.
  Required: `slug`. Off by default upstream; where it is
  not enabled the owner publishes from the dashboard.
- `unpublish_board` - return a board to draft so its
  public URL stops serving it. Required: `slug`.

Posts, votes and comments:

- `list_posts` - posts on a board, optionally filtered
  by `status`, search text `q` or `tag`, with `limit`
  and `offset` paging. Required: `slug`.
- `get_post` - one post in full. Required: `slug`,
  `post_id`.
- `create_post` - a new post on a board. Required:
  `slug`, `title`. Optional: `body`, `status`, `tags`.
- `update_post` - change mutable post fields such as
  `title`, `body`, `status`, `tags`, `pinned` and
  `queue_rank` (a null rank un-ranks the post).
  Required: `slug`, `post_id`.
- `delete_post` - hide a post through the developer API.
  Required: `slug`, `post_id`.
- `list_votes` - vote metadata for a post. Required:
  `slug`, `post_id`.
- `list_comments` - comments on a post. Required:
  `slug`, `post_id`.
- `create_comment` - comment as the board team,
  optionally replying via `parent_comment_id`. Required:
  `slug`, `post_id`, `body`.

Agent work queue:

- `get_queue` - the top unclaimed posts in the owner's
  curated build order: ranked posts first, then unranked
  planned posts by votes. Required: `slug`. Optional:
  `limit`.
- `claim_post` - atomically claim a post before working
  on it, so two agents never build the same thing.
  Required: `slug`, `post_id`. Optional: `ttl_seconds`
  (default 3600, max 86400) and `agent_label`.
- `release_post` - give a claim back so other agents can
  pick the post up. Required: `slug`, `post_id`.
- `add_evidence` - attach implementation evidence that
  voters see on the post page. Required: `slug`,
  `post_id`, `kind` (`branch`, `commit`, `pr`,
  `transcript` or `url`) and `ref`. Optional: `label`,
  `action_key`.
- `propose_status` - propose a status change
  (`open`, `planned`, `in_progress`, `shipped` or
  `declined`) for the board owner to confirm; nothing
  changes publicly until a human confirms. Required:
  `slug`, `post_id`, `status`. Optional: `note`,
  `action_key`.

Reads:

- `get_changelog` - shipped posts for a board.
  Required: `slug`.
- `get_analytics` - read-only analytics for a board,
  optionally for a `period`. Required: `slug`.
- `whoami` - confirm the caller's key by listing its
  accessible boards. No arguments.
- `ping` - check MCP and FeatureJet API reachability
  for the caller's key. No arguments.

## Configuration

- `FEATUREJET_MCP_URL` (optional) - override the upstream
  endpoint. Defaults to `https://mcp.featurejet.com/mcp`.
  (The override hook is this rebuild's own labelled
  reconstruction.)
- `FEATUREJET_API_KEY` (optional) - when set, every
  upstream request carries an
  `Authorization: Bearer <key>` header. When it is not
  set, no auth header is sent. (This forwarding is also
  a labelled reconstruction; the original surface was
  captured keyless, and the registry record declares the
  Authorization header as the key carrier.)

### Forwarding mechanics

On the first tool call the client opens a streamable
HTTP session with the upstream: a JSON-RPC `initialize`
request (protocolVersion `2025-03-26`, clientInfo name
`queueboard`), then a `notifications/initialized`
notification, then the `tools/call` request carrying
the caller's arguments unchanged. When the upstream
answers `initialize` with an `Mcp-Session-Id` header,
that value rides on every later request of the session,
which is reused for the life of the process. Replies
may arrive as plain JSON or as server-sent events;
both are read.

Successful upstream results pass through verbatim,
including any `isError` flag the upstream sets.
Failures - a JSON-RPC error, a non-2xx status, an
unreadable response, or a request that cannot be
completed - come back as an `isError` result whose
text starts with `queueboard error:` (this rendering
is this rebuild's own labelled reconstruction).

## CLI

Each tool is also a subcommand taking one JSON argument
string (omit it for tools that take none):

```bash
npx @reneturcios/queueboard list_boards
npx @reneturcios/queueboard get_board '{"slug":"ideas"}'
npx @reneturcios/queueboard create_post '{"slug":"ideas","title":"Dark mode"}'
npx @reneturcios/queueboard get_queue '{"slug":"ideas"}'
npx @reneturcios/queueboard claim_post '{"slug":"ideas","post_id":42}'
npx @reneturcios/queueboard --version
```

Exit codes: `0` on success, `1` on an `isError`
result, `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/queueboard mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "queueboard": {
      "command": "npx",
      "args": ["-y", "@reneturcios/queueboard", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/queueboard
docker run --rm ghcr.io/cloudcorprecords/queueboard --version
```

The container's default command is `mcp`, so the first
form is a stdio MCP server; any other arguments reach
the CLI normally.

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

The test suite runs entirely against a stubbed
JSON-RPC upstream - no live network calls.

## License

MIT - see `LICENSE`.
