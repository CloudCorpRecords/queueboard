# Changelog

## 0.1.0 (2026-10-27)

- First release: a forwarding client for the hosted FeatureJet MCP server, serving all 22 captured tools locally for tools/list and forwarding every tools/call upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when issued).
- Tools: `list_boards`, `get_board`, `create_board`, `publish_board`, `unpublish_board`, `list_posts`, `get_post`, `create_post`, `update_post`, `delete_post`, `list_votes`, `list_comments`, `create_comment`, `get_queue`, `claim_post`, `release_post`, `add_evidence`, `propose_status`, `get_changelog`, `get_analytics`, `whoami`, `ping`.
- Upstream results pass through verbatim; upstream failures surface as `queueboard error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). Upstream endpoint overridable via `FEATUREJET_MCP_URL`; when `FEATUREJET_API_KEY` is set it is sent as a Bearer token on every upstream request.
