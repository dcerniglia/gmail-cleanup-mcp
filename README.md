# Gmail Cleanup MCP Server

A focused [Model Context Protocol](https://modelcontextprotocol.io/) server for Gmail inbox cleanup — trash emails, manage filters, and extract unsubscribe links. Designed to complement Anthropic's built-in Gmail connector, which handles read, search, draft, and send.

## Tools

| Tool | Description |
|------|-------------|
| `trash_email` | Move a single email to trash (30-day safety net) |
| `batch_trash_emails` | Trash up to 500 emails by message ID, processed in batches of 50 |
| `search_and_trash` | Find emails by Gmail query and trash them — supports **dry-run** preview |
| `create_filter` | Create filters to auto-archive, auto-label, auto-delete, or forward |
| `list_filters` | List all existing Gmail filters with criteria and actions |
| `delete_filter` | Remove a Gmail filter by ID |
| `get_unsubscribe_info` | Extract `List-Unsubscribe` headers from an email |

## Prerequisites

- Node.js 18+
- A Google Cloud project with the Gmail API enabled
- OAuth 2.0 credentials (Desktop app type)

## Setup

### 1. Google Cloud OAuth

> **Already have `~/.gmail-mcp/gcp-oauth.keys.json` from another Gmail MCP server?** Skip to step 2 — this server uses the same credential location.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or reuse an existing one) and enable the **Gmail API**
3. Go to **Credentials** → **Create Credentials** → **OAuth client ID**
4. Choose **Desktop app**, download the JSON
5. Save it as `~/.gmail-mcp/gcp-oauth.keys.json` (or place `gcp-oauth.keys.json` in the project directory — it will be copied automatically on first run)

### 2. Install & Build

```bash
git clone https://github.com/davidcerniglia/gmail-cleanup-mcp.git
cd gmail-cleanup-mcp
npm install
npm run build
```

### 3. Authenticate

```bash
npm run auth
```

This opens a browser for Google OAuth consent. Credentials are saved to `~/.gmail-mcp/credentials.json` with `0600` permissions (owner-only).

### 4. Add to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "gmail-cleanup": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-cleanup-mcp/dist/index.js"]
    }
  }
}
```

Or for Claude Code, add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "gmail-cleanup": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-cleanup-mcp/dist/index.js"]
    }
  }
}
```

## Usage Examples

| Prompt | What happens |
|--------|-------------|
| *"Trash all emails from newsletter@spam.com older than 6 months"* | `search_and_trash` with Gmail query syntax |
| *"Do a dry run — show me what would get trashed from LinkedIn"* | `search_and_trash` with `dryRun: true` previews matches first |
| *"Create a filter to auto-archive emails from nextdoor.com"* | `create_filter` with `removeLabelIds: ["INBOX"]` |
| *"Check if that marketing email has an unsubscribe link"* | `get_unsubscribe_info` extracts the `List-Unsubscribe` header |

### How it works with Claude's built-in Gmail

| | Built-in Gmail connector | This server |
|---|---|---|
| **Search & read** | Yes | — |
| **Draft & send** | Yes | — |
| **Trash emails** | — | Yes |
| **Bulk cleanup** | — | Yes (up to 500/call) |
| **Filter management** | — | Yes |
| **Unsubscribe extraction** | — | Yes |

## Security

- **Minimal scopes**: `gmail.modify` + `gmail.settings.basic` — the minimum needed for trash and filter operations
- **Trash, not delete**: All deletions use Gmail's trash (30-day recovery window), never permanent delete
- **Dry-run mode**: `search_and_trash` can preview matches before committing
- **Restrictive file permissions**: Credentials stored with `0600` (owner read/write only)
- **No attachment handling**: Zero path traversal risk
- **No filesystem access** beyond credential storage in `~/.gmail-mcp/`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GMAIL_OAUTH_PATH` | `~/.gmail-mcp/gcp-oauth.keys.json` | Path to OAuth client keys |
| `GMAIL_CREDENTIALS_PATH` | `~/.gmail-mcp/credentials.json` | Path to stored credentials |

## License

MIT
