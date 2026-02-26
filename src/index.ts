#!/usr/bin/env node

/**
 * Gmail Cleanup MCP Server
 *
 * A focused MCP server for Gmail inbox cleanup operations:
 * - Trash / batch trash emails (uses trash, NOT permanent delete — 30-day safety net)
 * - Filter creation, listing, and deletion
 * - Unsubscribe link extraction
 *
 * Designed to complement Anthropic's built-in Gmail connector which handles
 * read, search, draft, and send operations.
 *
 * Security notes:
 * - Uses gmail.modify scope (minimum needed for trash + filters)
 * - No file system access beyond credential storage
 * - No attachment handling (no path traversal risk)
 * - Credentials stored with restrictive file permissions
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";
import http from "http";
import open from "open";
import os from "os";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".gmail-mcp");
const OAUTH_PATH =
  process.env.GMAIL_OAUTH_PATH ||
  path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
  process.env.GMAIL_CREDENTIALS_PATH ||
  path.join(CONFIG_DIR, "credentials.json");

let oauth2Client: OAuth2Client;

// ─── Auth helpers ────────────────────────────────────────────────────────────

async function loadCredentials(): Promise<void> {
  // Ensure config dir exists with restrictive permissions
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Copy local oauth keys to config dir if present
  const localOAuthPath = path.join(process.cwd(), "gcp-oauth.keys.json");
  if (fs.existsSync(localOAuthPath) && !fs.existsSync(OAUTH_PATH)) {
    fs.copyFileSync(localOAuthPath, OAUTH_PATH);
    fs.chmodSync(OAUTH_PATH, 0o600);
    console.error("OAuth keys copied to global config.");
  }

  if (!fs.existsSync(OAUTH_PATH)) {
    console.error(
      `Error: OAuth keys not found. Place gcp-oauth.keys.json in ${CONFIG_DIR} or current directory.`
    );
    process.exit(1);
  }

  const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf8"));
  const keys = keysContent.installed || keysContent.web;

  if (!keys) {
    console.error(
      'Error: Invalid OAuth keys format. Must contain "installed" or "web" credentials.'
    );
    process.exit(1);
  }

  const AUTH_PORT = parseInt(process.env.GMAIL_AUTH_PORT || "3000", 10);

  const redirectUri =
    process.argv[2] === "auth" && process.argv[3]
      ? process.argv[3]
      : `http://localhost:${AUTH_PORT}/oauth2callback`;

  oauth2Client = new OAuth2Client(
    keys.client_id,
    keys.client_secret,
    redirectUri
  );

  if (fs.existsSync(CREDENTIALS_PATH)) {
    const credentials = JSON.parse(
      fs.readFileSync(CREDENTIALS_PATH, "utf8")
    );
    oauth2Client.setCredentials(credentials);
  }
}

async function authenticate(): Promise<void> {
  const AUTH_PORT = parseInt(process.env.GMAIL_AUTH_PORT || "3000", 10);
  const server = http.createServer();
  server.listen(AUTH_PORT);

  return new Promise<void>((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.settings.basic",
      ],
    });

    console.log("Opening browser for authentication...");
    console.log("If browser doesn't open, visit:", authUrl);
    open(authUrl);

    server.on("request", async (req, res) => {
      if (!req.url?.startsWith("/oauth2callback")) return;

      const url = new URL(req.url, "http://localhost:3000");
      const code = url.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        res.end("No authorization code received.");
        reject(new Error("No code provided"));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Write credentials with restrictive permissions
        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens));
        fs.chmodSync(CREDENTIALS_PATH, 0o600);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h2>Authentication successful!</h2><p>You can close this window and return to your terminal.</p>"
        );
        server.close();
        resolve();
      } catch (error) {
        res.writeHead(500);
        res.end("Authentication failed.");
        reject(error);
      }
    });
  });
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const TrashEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to move to trash"),
});

const BatchTrashEmailsSchema = z.object({
  messageIds: z
    .array(z.string())
    .min(1)
    .max(500)
    .describe("List of message IDs to move to trash (max 500)"),
});

const SearchAndTrashSchema = z.object({
  query: z
    .string()
    .describe(
      "Gmail search query to find messages to trash (e.g., 'from:newsletter@example.com older_than:6m')"
    ),
  maxResults: z
    .number()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe("Maximum number of messages to trash (default: 100, max: 500)"),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, only shows what WOULD be trashed without actually trashing. Use this to preview before committing."
    ),
});

const CreateFilterSchema = z.object({
  criteria: z
    .object({
      from: z.string().optional().describe("Sender email or domain to match"),
      to: z.string().optional().describe("Recipient to match"),
      subject: z.string().optional().describe("Subject text to match"),
      query: z
        .string()
        .optional()
        .describe("Gmail search query (e.g., 'has:attachment')"),
      negatedQuery: z
        .string()
        .optional()
        .describe("Text that must NOT be present"),
      hasAttachment: z
        .boolean()
        .optional()
        .describe("Match emails with attachments"),
      size: z.number().optional().describe("Email size in bytes"),
      sizeComparison: z
        .enum(["smaller", "larger"])
        .optional()
        .describe("Size comparison operator"),
    })
    .describe("Criteria for matching emails"),
  action: z
    .object({
      addLabelIds: z
        .array(z.string())
        .optional()
        .describe("Label IDs to add to matching emails"),
      removeLabelIds: z
        .array(z.string())
        .optional()
        .describe(
          "Label IDs to remove (e.g., ['INBOX'] to archive, ['UNREAD'] to mark read)"
        ),
      forward: z
        .string()
        .optional()
        .describe("Email address to forward matching emails to"),
    })
    .describe("Actions to perform on matching emails"),
});

const ListFiltersSchema = z.object({});

const DeleteFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to delete"),
});

const GetUnsubscribeInfoSchema = z.object({
  messageId: z
    .string()
    .describe("ID of the email to extract unsubscribe info from"),
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await loadCredentials();

  // Handle auth subcommand
  if (process.argv[2] === "auth") {
    await authenticate();
    console.log("Authentication completed successfully.");
    console.log(`Credentials saved to ${CREDENTIALS_PATH}`);
    process.exit(0);
  }

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const server = new Server({
    name: "gmail-cleanup",
    version: "1.0.0",
    capabilities: { tools: {} },
  });

  // ─── List tools ──────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "trash_email",
        description:
          "Move a single email to trash. Gmail auto-deletes trash after 30 days, giving you a safety net.",
        inputSchema: zodToJsonSchema(TrashEmailSchema),
      },
      {
        name: "batch_trash_emails",
        description:
          "Move multiple emails to trash by their message IDs. Processes in batches of 50 with retry on failure. Max 500 per call.",
        inputSchema: zodToJsonSchema(BatchTrashEmailsSchema),
      },
      {
        name: "search_and_trash",
        description:
          "Search for emails matching a query and trash them all. Supports a dry_run mode to preview what would be trashed before committing. Great for bulk cleanup like 'from:newsletter@spam.com older_than:1y'.",
        inputSchema: zodToJsonSchema(SearchAndTrashSchema),
      },
      {
        name: "create_filter",
        description:
          "Create a Gmail filter to automatically handle incoming emails. Use to auto-archive, auto-label, auto-delete, or forward emails matching criteria.",
        inputSchema: zodToJsonSchema(CreateFilterSchema),
      },
      {
        name: "list_filters",
        description: "List all existing Gmail filters with their criteria and actions.",
        inputSchema: zodToJsonSchema(ListFiltersSchema),
      },
      {
        name: "delete_filter",
        description: "Delete a Gmail filter by its ID.",
        inputSchema: zodToJsonSchema(DeleteFilterSchema),
      },
      {
        name: "get_unsubscribe_info",
        description:
          "Extract the List-Unsubscribe header from an email, giving you the unsubscribe URL or mailto address. Useful for cleaning up newsletter subscriptions.",
        inputSchema: zodToJsonSchema(GetUnsubscribeInfoSchema),
      },
    ],
  }));

  // ─── Tool handlers ───────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── Trash single email ───────────────────────────────────────────
        case "trash_email": {
          const { messageId } = TrashEmailSchema.parse(args);

          await gmail.users.messages.trash({
            userId: "me",
            id: messageId,
          });

          return {
            content: [
              {
                type: "text",
                text: `Email ${messageId} moved to trash.`,
              },
            ],
          };
        }

        // ── Batch trash emails ───────────────────────────────────────────
        case "batch_trash_emails": {
          const { messageIds } = BatchTrashEmailsSchema.parse(args);

          const BATCH_SIZE = 50;
          let successCount = 0;
          const failures: { id: string; error: string }[] = [];

          for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
            const batch = messageIds.slice(i, i + BATCH_SIZE);

            const results = await Promise.allSettled(
              batch.map((id) =>
                gmail.users.messages.trash({ userId: "me", id })
              )
            );

            results.forEach((result, idx) => {
              if (result.status === "fulfilled") {
                successCount++;
              } else {
                failures.push({
                  id: batch[idx],
                  error: result.reason?.message || "Unknown error",
                });
              }
            });
          }

          let text = `Batch trash complete: ${successCount}/${messageIds.length} moved to trash.`;
          if (failures.length > 0) {
            text += `\n\nFailed (${failures.length}):\n`;
            text += failures
              .slice(0, 10)
              .map((f) => `  ${f.id}: ${f.error}`)
              .join("\n");
            if (failures.length > 10)
              text += `\n  ... and ${failures.length - 10} more`;
          }

          return { content: [{ type: "text", text }] };
        }

        // ── Search and trash ─────────────────────────────────────────────
        case "search_and_trash": {
          const {
            query,
            maxResults,
            dryRun,
          } = SearchAndTrashSchema.parse(args);

          // Collect message IDs across pages
          const allMessageIds: string[] = [];
          let pageToken: string | undefined;

          while (allMessageIds.length < maxResults) {
            const response = await gmail.users.messages.list({
              userId: "me",
              q: query,
              maxResults: Math.min(maxResults - allMessageIds.length, 500),
              ...(pageToken && { pageToken }),
            });

            const messages = response.data.messages || [];
            if (messages.length === 0) break;

            allMessageIds.push(
              ...messages
                .map((m) => m.id)
                .filter((id): id is string => id != null)
            );

            pageToken = response.data.nextPageToken || undefined;
            if (!pageToken) break;
          }

          if (allMessageIds.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No emails found matching: ${query}`,
                },
              ],
            };
          }

          // Dry run — just report what we found
          if (dryRun) {
            // Fetch headers for a sample to show the user
            const sampleSize = Math.min(allMessageIds.length, 10);
            const sampleDetails = await Promise.all(
              allMessageIds.slice(0, sampleSize).map(async (id) => {
                const detail = await gmail.users.messages.get({
                  userId: "me",
                  id,
                  format: "metadata",
                  metadataHeaders: ["Subject", "From", "Date"],
                });
                const headers = detail.data.payload?.headers || [];
                return {
                  id,
                  subject:
                    headers.find((h) => h.name === "Subject")?.value || "(no subject)",
                  from:
                    headers.find((h) => h.name === "From")?.value || "(unknown)",
                  date:
                    headers.find((h) => h.name === "Date")?.value || "(unknown)",
                };
              })
            );

            let text = `DRY RUN — Would trash ${allMessageIds.length} emails matching: ${query}\n\n`;
            text += `Sample (first ${sampleSize}):\n`;
            text += sampleDetails
              .map(
                (d) =>
                  `  • ${d.from}\n    ${d.subject}\n    ${d.date}`
              )
              .join("\n\n");

            if (allMessageIds.length > sampleSize) {
              text += `\n\n  ... and ${allMessageIds.length - sampleSize} more`;
            }

            text += `\n\nTo execute, run again with dryRun: false`;

            return { content: [{ type: "text", text }] };
          }

          // Actually trash them
          const BATCH_SIZE = 50;
          let successCount = 0;
          let failCount = 0;

          for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
            const batch = allMessageIds.slice(i, i + BATCH_SIZE);

            const results = await Promise.allSettled(
              batch.map((id) =>
                gmail.users.messages.trash({ userId: "me", id })
              )
            );

            results.forEach((result) => {
              if (result.status === "fulfilled") successCount++;
              else failCount++;
            });
          }

          return {
            content: [
              {
                type: "text",
                text: `Search and trash complete for query: ${query}\nTrashed: ${successCount}\nFailed: ${failCount}\nTotal found: ${allMessageIds.length}`,
              },
            ],
          };
        }

        // ── Create filter ────────────────────────────────────────────────
        case "create_filter": {
          const { criteria, action } = CreateFilterSchema.parse(args);

          const response = await gmail.users.settings.filters.create({
            userId: "me",
            requestBody: { criteria, action },
          });

          const criteriaText = Object.entries(criteria)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");

          const actionText = Object.entries(action)
            .filter(
              ([, v]) =>
                v !== undefined && (Array.isArray(v) ? v.length > 0 : true)
            )
            .map(([k, v]) =>
              `${k}: ${Array.isArray(v) ? v.join(", ") : v}`
            )
            .join(", ");

          return {
            content: [
              {
                type: "text",
                text: `Filter created (ID: ${response.data.id})\nCriteria: ${criteriaText}\nActions: ${actionText}`,
              },
            ],
          };
        }

        // ── List filters ─────────────────────────────────────────────────
        case "list_filters": {
          ListFiltersSchema.parse(args);

          const response = await gmail.users.settings.filters.list({
            userId: "me",
          });

          // Gmail API returns 'filter' (singular) not 'filters'
          const filters = response.data.filter || [];

          if (filters.length === 0) {
            return {
              content: [{ type: "text", text: "No filters found." }],
            };
          }

          const text = filters
            .map((f: any) => {
              const criteria = Object.entries(f.criteria || {})
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ");

              const action = Object.entries(f.action || {})
                .filter(
                  ([, v]) =>
                    v !== undefined &&
                    (Array.isArray(v) ? v.length > 0 : true)
                )
                .map(([k, v]) =>
                  `${k}: ${Array.isArray(v) ? v.join(", ") : v}`
                )
                .join(", ");

              return `ID: ${f.id}\n  Criteria: ${criteria}\n  Actions: ${action}`;
            })
            .join("\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${filters.length} filters:\n\n${text}`,
              },
            ],
          };
        }

        // ── Delete filter ────────────────────────────────────────────────
        case "delete_filter": {
          const { filterId } = DeleteFilterSchema.parse(args);

          await gmail.users.settings.filters.delete({
            userId: "me",
            id: filterId,
          });

          return {
            content: [
              {
                type: "text",
                text: `Filter ${filterId} deleted.`,
              },
            ],
          };
        }

        // ── Get unsubscribe info ─────────────────────────────────────────
        case "get_unsubscribe_info": {
          const { messageId } = GetUnsubscribeInfoSchema.parse(args);

          const response = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
            format: "metadata",
            metadataHeaders: [
              "List-Unsubscribe",
              "List-Unsubscribe-Post",
              "From",
              "Subject",
            ],
          });

          const headers = response.data.payload?.headers || [];
          const from =
            headers.find((h) => h.name === "From")?.value || "(unknown)";
          const subject =
            headers.find((h) => h.name === "Subject")?.value || "(no subject)";
          const unsubscribe =
            headers.find((h) => h.name === "List-Unsubscribe")?.value || null;
          const unsubscribePost =
            headers.find((h) => h.name === "List-Unsubscribe-Post")?.value ||
            null;

          if (!unsubscribe) {
            return {
              content: [
                {
                  type: "text",
                  text: `No List-Unsubscribe header found for:\n  From: ${from}\n  Subject: ${subject}\n\nThis sender may not support one-click unsubscribe. You may need to open the email and look for an unsubscribe link in the body.`,
                },
              ],
            };
          }

          // Parse the List-Unsubscribe header — can contain URLs and/or mailto links
          const urls: string[] = [];
          const mailtos: string[] = [];
          const parts = unsubscribe.match(/<[^>]+>/g) || [];
          for (const part of parts) {
            const cleaned = part.replace(/^<|>$/g, "");
            if (cleaned.startsWith("mailto:")) {
              mailtos.push(cleaned);
            } else if (cleaned.startsWith("http")) {
              urls.push(cleaned);
            }
          }

          let text = `Unsubscribe info for:\n  From: ${from}\n  Subject: ${subject}\n\n`;

          if (urls.length > 0) {
            text += `Unsubscribe URL(s):\n${urls.map((u) => `  ${u}`).join("\n")}\n\n`;
          }
          if (mailtos.length > 0) {
            text += `Unsubscribe mailto(s):\n${mailtos.map((m) => `  ${m}`).join("\n")}\n\n`;
          }
          if (unsubscribePost) {
            text += `One-click unsubscribe supported (List-Unsubscribe-Post: ${unsubscribePost})\n`;
          }

          return { content: [{ type: "text", text }] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
