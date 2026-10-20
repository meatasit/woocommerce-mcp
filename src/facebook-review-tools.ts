/**
 * MCP tools for the Facebook post review queue (see facebook-review.ts).
 *
 * Designed around one scenario: drafts keep arriving, the approver is away
 * for a few days, and when they are back they want to see what piled up —
 * by day — and clear it in a few calls.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { POST_STATUSES, REVIEW_DECISIONS, ReviewQueue } from "./facebook-review.js";
import { fail, ok, type ToolResult } from "./result.js";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export function registerFacebookReviewTools(server: McpServer, queue?: ReviewQueue): void {
  // Resolve lazily so a bad FB_REVIEW_* env var surfaces as a tool error, not a crash at startup.
  const q = (): ReviewQueue => queue ?? (queue = ReviewQueue.fromEnv());

  server.registerTool(
    "queue_facebook_post",
    {
      title: "Queue Facebook post for review",
      description:
        "Add a drafted Facebook post to the review backlog. It stays pending (never expires, never auto-publishes) " +
        "until a human approves or rejects it — even if that takes days. Returns the queued post with its id.",
      inputSchema: {
        message: z.string().min(1).describe("Post text (the caption that would go on Facebook)"),
        image_urls: z.array(z.string().url()).max(10).optional().describe("Image URLs to attach (e.g. product images)"),
        link: z.string().url().optional().describe("Link to include, e.g. the product permalink"),
        product_id: z.number().int().positive().optional().describe("WooCommerce product id this post promotes"),
        product_name: z.string().optional().describe("Product name, for display in the backlog"),
        scheduled_for: z.string().optional().describe("Intended publish time (ISO 8601). Informational only; nothing publishes itself."),
        notes: z.string().optional().describe("Notes for the reviewer: why this post, what to double-check"),
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        return ok(await q().add(input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_facebook_posts",
    {
      title: "List Facebook post backlog",
      description:
        "List queued Facebook posts, oldest first by default so a multi-day backlog is worked in arrival order. " +
        "Defaults to pending posts. Each post carries review_day (the day it was queued), age_days and overdue " +
        "(pending but scheduled time already passed).",
      inputSchema: {
        status: z.enum([...POST_STATUSES, "all"]).optional().describe("Status filter (default pending)"),
        from_day: DAY.optional().describe("Only posts queued on or after this day (YYYY-MM-DD)"),
        to_day: DAY.optional().describe("Only posts queued on or before this day (YYYY-MM-DD)"),
        scheduled_before: z.string().optional().describe('Only posts scheduled at or before this ISO time, or "now"'),
        overdue_only: z.boolean().optional().describe("Only pending posts whose scheduled time has passed"),
        order: z.enum(["oldest", "newest"]).optional().describe("Sort order (default oldest)"),
        limit: z.number().int().min(1).max(500).optional().describe("Max posts to return (default 50)"),
      },
    },
    async (input): Promise<ToolResult> => {
      try {
        return ok(await q().list(input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_facebook_post",
    {
      title: "Get queued Facebook post",
      description: "Full details and history of one queued Facebook post by id.",
      inputSchema: { id: z.string().min(1).describe("Queued post id (fb-...)") },
    },
    async ({ id }): Promise<ToolResult> => {
      try {
        return ok(await q().get(id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_facebook_post",
    {
      title: "Edit pending Facebook post",
      description:
        "Edit a pending post before deciding on it: fix the caption, swap images, change the link or the intended " +
        "publish time. Only pending posts can be edited (reopen an approved/rejected one first).",
      inputSchema: {
        id: z.string().min(1).describe("Queued post id"),
        message: z.string().min(1).optional().describe("New post text"),
        image_urls: z.array(z.string().url()).max(10).optional().describe("Replacement image URL list (empty array clears)"),
        link: z.string().optional().describe("New link; empty string removes it"),
        scheduled_for: z.string().optional().describe("New intended publish time (ISO 8601); empty string removes it"),
        notes: z.string().optional().describe("New reviewer notes; empty string removes them"),
      },
    },
    async ({ id, ...patch }): Promise<ToolResult> => {
      try {
        return ok(await q().update(id, patch));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "review_facebook_posts",
    {
      title: "Approve / reject Facebook posts",
      description:
        "Apply one decision to one or many queued posts. Select by ids, by review_day (everything queued that day), " +
        "or all_pending=true (the whole backlog). approve/reject act on pending posts; reopen returns an approved or " +
        "rejected post to pending. Posts in the wrong state are listed under skipped instead of failing the batch.",
      inputSchema: {
        decision: z.enum(REVIEW_DECISIONS).describe("approve, reject, or reopen"),
        ids: z.array(z.string().min(1)).max(500).optional().describe("Post ids to act on"),
        review_day: DAY.optional().describe("Act on every pending post queued on this day (YYYY-MM-DD)"),
        all_pending: z.boolean().optional().describe("Act on every pending post, regardless of day"),
        note: z.string().optional().describe("Reviewer note stored with the decision (e.g. reason for rejecting)"),
        scheduled_for: z.string().optional().describe("New intended publish time for the selected posts (e.g. to reschedule overdue ones)"),
      },
    },
    async ({ decision, ids, review_day, all_pending, note, scheduled_for }): Promise<ToolResult> => {
      try {
        const result = await q().review({ ids, review_day, all_pending }, decision, { note, scheduled_for });
        return ok({ decision, updated_count: result.updated.length, skipped_count: result.skipped.length, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "mark_facebook_post_published",
    {
      title: "Mark Facebook posts as published",
      description:
        "Record that approved posts went live on Facebook (done by whatever publishes them). Moves them from approved " +
        "to published so they drop out of the to-publish list.",
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(500).describe("Approved post ids that were published"),
        facebook_post_id: z.string().optional().describe("Facebook post id, when publishing a single post"),
        published_at: z.string().optional().describe("Publish time (ISO 8601); defaults to now"),
      },
    },
    async ({ ids, facebook_post_id, published_at }): Promise<ToolResult> => {
      try {
        const result = await q().markPublished(ids, { facebook_post_id, published_at });
        return ok({ updated_count: result.updated.length, skipped_count: result.skipped.length, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_facebook_posts",
    {
      title: "Delete finished Facebook posts",
      description:
        "Permanently remove approved, rejected or published posts from the queue file (housekeeping). Pending posts " +
        "are never deleted here — reject them first.",
      inputSchema: { ids: z.array(z.string().min(1)).min(1).max(500).describe("Post ids to remove") },
    },
    async ({ ids }): Promise<ToolResult> => {
      try {
        return ok(await q().remove(ids));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "facebook_review_summary",
    {
      title: "Facebook review backlog summary",
      description:
        "One-call overview for catching up after days away: counts per status, pending posts grouped by the day they " +
        "were queued (oldest first), how many days of backlog there are, the oldest pending post, how many pending " +
        "posts are overdue, and how many approved posts still await publishing.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        return ok(await q().summary());
      } catch (e) {
        return fail(e);
      }
    },
  );
}
