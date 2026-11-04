# BUILD REPORT — queueboard

Rebuild of `com.featurejet/feedback-board` (remote-only, keyless capture)
as `@reneturcios/queueboard` 0.1.0 / `io.github.CloudCorpRecords/queueboard`.

## Fixture conflicts

**None.** The brief, the spec prose, and the fixture agree on all 22 tool
names and every required field. Required fields as served, taken from the
fixture (`harness/fixtures/featurejet-tools-original.json`):

- `list_boards` — required: none (no `required` key)
- `get_board` — required: `slug`
- `create_board` — required: `name`, `slug`
- `publish_board` — required: `slug`
- `unpublish_board` — required: `slug`
- `list_posts` — required: `slug`
- `get_post` — required: `slug`, `post_id`
- `create_post` — required: `slug`, `title`
- `update_post` — required: `slug`, `post_id`
- `delete_post` — required: `slug`, `post_id`
- `list_votes` — required: `slug`, `post_id`
- `list_comments` — required: `slug`, `post_id`
- `create_comment` — required: `slug`, `post_id`, `body`
- `get_queue` — required: `slug`
- `claim_post` — required: `slug`, `post_id`
- `release_post` — required: `slug`, `post_id`
- `add_evidence` — required: `slug`, `post_id`, `kind`, `ref`
- `propose_status` — required: `slug`, `post_id`, `status`
- `get_changelog` — required: `slug`
- `get_analytics` — required: `slug`
- `whoami` — required: none (no `required` key)
- `ping` — required: none (no `required` key)

The fixture's tool literals carry exactly the keys `name`, `description`,
`inputSchema` per tool — no `title` key on any tool — and are served
verbatim from `src/forward.ts` (the literals were generated directly from
the fixture JSON to avoid transcription drift). The capture's
`outputSchema`/`execution` blocks are not reproduced, per the spec
(parity compares inputSchema).

## What was built

All 19 factory files under `builds/queueboard/`:

- `package.json` (`@reneturcios/queueboard` 0.1.0, bin
  `queueboard` → `dist/cli.js`, deps exactly `@modelcontextprotocol/sdk ^1`
  + `zod ^3`; devDeps `@types/node ^20`, `tsx ^4`, `typescript ^5`)
- `server.json` (description exactly the prescribed 87-char string
  "Feedback boards for product teams: posts, votes, comments, agent work queue, changelog.";
  npm entry carries `"version": "0.1.0"`; OCI entry
  `ghcr.io/cloudcorprecords/queueboard:0.1.0` carries **no** version field)
- `Dockerfile` (node:20-alpine both stages; server-name label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/queueboard"`
  matches `server.json`)
- `tsconfig.json` (fleet-identical, 318 bytes), `.gitignore`,
  `package-lock.json`, `README.md` (fresh prose), `LICENSE` (MIT,
  Copyright (c) 2026 Rene Turcios), `CHANGELOG.md` (single 0.1.0 entry,
  2026-10-27)
- `src/index.ts`, `src/cli.ts`, `src/mcp.ts`, `src/types.ts`,
  `src/forward.ts` (core; exports `VERSION = "0.1.0"`)
- `test/forward.test.ts`
- `.github/workflows/{ci.yml, publish.yml, publish-container.yml,
  registry-publish.yml}` (container workflow: IMAGE
  `ghcr.io/cloudcorprecords/queueboard`, smoke assertion on server name
  `queueboard`)

## Design

- Forwarding client to `https://mcp.featurejet.com/mcp` (pinned),
  overridable via `FEATUREJET_MCP_URL` (labelled reconstruction).
  tools/call is forwarded as a streamable-HTTP JSON-RPC client:
  initialize (protocolVersion `2025-03-26`, clientInfo `queueboard`) →
  notifications/initialized → tools/call, honouring `Mcp-Session-Id`
  when issued; session established lazily and reused per client.
  Plain-JSON and SSE replies both parsed; the matching-id message
  wins; upstream results pass through verbatim (including `isError`
  and extra fields such as `structuredContent`).
- When `FEATUREJET_API_KEY` is set, `Authorization: Bearer <key>` is
  sent on every upstream request (labelled reconstruction; the capture
  was keyless); when unset, no auth header is sent. Both branches are
  covered by tests.
- Upstream failures (JSON-RPC error, non-2xx status, malformed body,
  throwing/timing-out fetch) surface as `queueboard error:` text
  results (labelled reconstruction).
- Registration via the MCP SDK **low-level** `Server` API
  (`ListToolsRequestSchema` / `CallToolRequestSchema` handlers) serving
  the fixture literals exactly; no `McpServer` + zod registration.
  `src/mcp.ts` also exports `createServer` / `startMcpServer` /
  `handleCallTool` so the MCP layer is testable without a transport;
  the CLI's `mcp` subcommand starts it over stdio.
- Core takes an injectable fetch (`ForwardDeps.fetchFn`), so all tests
  run against a stubbed JSON-RPC upstream. No live network calls in
  tests; no live call claimed anywhere.

## Lockfile (Route 3, clean from birth)

Generated in a temp dir containing only the new `package.json`:
`npm install --package-lock-only --ignore-scripts --offline`.
Verified: parses, `name == @reneturcios/queueboard`, **128 package
entries**; copied into the build dir with matching sha256
(`37fb24a423a936c9f778d18c13358892a708f261a35de3d587618f8d4c9532c0`
on both sides). Then `npm install --offline --ignore-scripts` in the
build dir for `node_modules`. No write-guard failure occurred; the
/tmp staging was the Route 3 generation step itself, not a fallback.

## Verification (all in the build dir unless noted)

- `npx tsc --noEmit` → exit 0
- `npm run build` → real `dist/` (cli.js 2346 B, forward.js 31278 B,
  mcp.js 2670 B, all non-empty, with `.d.ts` + source maps)
- `node dist/cli.js --version` → `0.1.0`; unknown subcommand → usage on
  stderr, exit 2
- `npm test` → **39 tests, 39 pass, 0 fail** (8 suites: registration
  integrity — served tools deep-equal the fixture's full 22 tool
  objects, names in order, required fields per tool, no title keys;
  session establishment/reuse/session-id handling; env URL override +
  Bearer header when the key is set / absent when unset; verbatim
  argument forwarding across board/post/queue/evidence/status tools;
  verbatim result pass-through incl. upstream isError and SSE;
  JSON-RPC/init/malformed/HTTP/throw/timeout failures →
  `queueboard error:`; parseRpcBody; MCP-layer validation;
  CLI --version / unknown exit 2 / bad-JSON exit 2)
- Parity: `python3 harness/parity.py --original
  harness/fixtures/featurejet-tools-original.json --rebuild
  "stdio:node builds/queueboard/dist/cli.js mcp" --out
  builds/queueboard/parity-out` (run from `~/workspace/mcp-rebuild-100`)
  → **PASS, parity 100.0, 22/22 identical, no missing/extra/schema
  diffs** (see `parity-out/parity.json`)
- Consistency sweep: package.json version = server.json top-level =
  npm-entry version = OCI tag = core `VERSION` = CHANGELOG heading
  (0.1.0); package.json `mcpName` = server.json `name` = Dockerfile
  label; server.json description measured at 87 chars; OCI entry
  confirmed to have no `version` field.

Clean-room: all prose and code written fresh for queueboard, following
only the mechanics of the sibling askboard build; only the fixture's
tool literals are served verbatim.
