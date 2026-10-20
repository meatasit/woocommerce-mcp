# woocommerce-mcp

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for **WordPress + WooCommerce**. It lets Claude (or any MCP client) answer questions about a live store — products, orders, sales, and blog posts — over the official REST APIs. No writes, no plugins to install on the store: it talks to the existing WordPress/WooCommerce REST endpoints.

It also ships a **Facebook post review backlog**: drafted posts wait in a local queue — for days if needed — until a human approves them. See [Facebook post review backlog](#facebook-post-review-backlog).

Built and maintained by [WPPoland](https://wppoland.com/en/), a [senior WordPress developer](https://wppoland.com/en/wordpress-developer/) working with WordPress since 2006. If you need this wired into a real store stack, we build [WooCommerce ERP and API integrations](https://wppoland.com/en/woocommerce-erp-integration/) and [enterprise e-commerce architecture](https://wppoland.com/en/enterprise-solutions/) (headless, integrations, AI-ready data).

## Tools

| Tool | What it does | Needs WooCommerce keys |
|------|--------------|:---:|
| `list_products` | List / search products (name, sku, price, stock, permalink) | yes |
| `get_product` | Full details for one product by id | yes |
| `list_orders` | Recent orders, newest first, optional status filter | yes |
| `sales_report` | Sales totals for a period (week / month / last_month / year) | yes |
| `search_posts` | Search published blog posts (public WP REST API) | no |
| `queue_facebook_post` | Add a drafted Facebook post to the review backlog | no |
| `list_facebook_posts` | List the backlog (pending by default), oldest first, with `review_day`, `age_days`, `overdue` | no |
| `get_facebook_post` | One queued post with its full history | no |
| `update_facebook_post` | Edit a pending post (caption, images, link, schedule, notes) | no |
| `review_facebook_posts` | Approve / reject / reopen posts by ids, by day, or the whole backlog | no |
| `mark_facebook_post_published` | Record that approved posts went live | no |
| `delete_facebook_posts` | Housekeeping: remove approved / rejected / published posts | no |
| `facebook_review_summary` | Backlog overview: counts, pending posts per day, oldest, overdue | no |

The store tools are **read-only**. The server never creates, edits, or deletes anything in the store. The `*_facebook_*` tools only touch a local JSON file (see below); they never call Facebook either.

## Install & build

From npm (package name is scoped - the unscoped `woocommerce-mcp` name is locked on the registry):

```bash
npm install -g @wppoland/woocommerce-mcp
# or: npx @wppoland/woocommerce-mcp
```

From source:

```bash
git clone https://github.com/wppoland/woocommerce-mcp.git
cd woocommerce-mcp
npm install
npm run build
```

## Configure

Set three environment variables:

| Var | Required | Example |
|-----|:---:|---------|
| `WP_URL` | yes | `https://shop.example.com` |
| `WC_CONSUMER_KEY` | for `wc_*` tools | `ck_xxx` |
| `WC_CONSUMER_SECRET` | for `wc_*` tools | `cs_xxx` |

Create the WooCommerce keys in **WooCommerce → Settings → Advanced → REST API → Add key** with **Read** permission. `search_posts` works without keys against any public WordPress site.

> The keys are sent to your own store over HTTPS as REST query auth. Use HTTPS, and give the key **Read** access only.

Two optional variables configure the Facebook review backlog:

| Var | Default | Purpose |
|-----|---------|---------|
| `FB_REVIEW_QUEUE_PATH` | `~/.woocommerce-mcp/facebook-review-queue.json` | Where the backlog is stored. Point it at a persistent path (a mounted volume in Docker). |
| `FB_REVIEW_TIMEZONE` | system time zone | IANA zone (e.g. `Asia/Bangkok`) used to stamp the `review_day` of each post. Set it explicitly in Docker, where the system zone is UTC. |

## Facebook post review backlog

Drafts for Facebook (from an agent, a script, or a colleague) go into a queue and wait for a human to approve them. The queue is built for the case where the approver is away for a few days:

- **Nothing expires.** A post stays `pending` until someone decides. There is no auto-approve and no auto-publish; a scheduled time that passes just marks the post `overdue`.
- **Every post remembers the day it was queued** (`review_day`), so a backlog of several days can be worked day by day, oldest first.
- **Decisions are batched.** Approve or reject by ids, a whole day (`review_day`), or the entire backlog (`all_pending`). Posts in the wrong state are reported as `skipped`, never abort the batch.
- **Durable and safe.** State lives in one JSON file, written atomically. A file that fails to parse is never overwritten, so a backlog cannot be lost silently.
- **Audit trail.** Each post keeps a history (queued, edited, approved, rejected, reopened, published) with timestamps and notes.

Lifecycle: `pending` → `approved` → `published`, or `pending` → `rejected`. `reopen` returns an approved or rejected post to `pending` (for example to change your mind or edit it). Publishing itself is outside this server: whatever posts to Facebook (a Facebook MCP, a scheduler, a human) reads the `approved` posts and reports back with `mark_facebook_post_published`.

A typical catch-up after being away:

1. `facebook_review_summary` — how many days of backlog, how many pending per day, anything overdue.
2. `list_facebook_posts` with `from_day`/`to_day` (or `overdue_only: true`) — read one day at a time.
3. `update_facebook_post` to fix a caption, then `review_facebook_posts` with `decision: "approve"` and `review_day` for the good days, or `ids` + `note` for the ones to reject. Pass `scheduled_for` to give overdue posts a new time.
4. Someone publishes the `approved` posts and calls `mark_facebook_post_published`.

Ask Claude things like *"What Facebook posts are waiting for my review, grouped by day?"*, *"Approve everything queued on 2026-10-18 except the sale post"*, or *"Reject the overdue ones with the note 'promo ended'"*.

## Use with Claude Desktop / Claude Code

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "node",
      "args": ["/absolute/path/to/woocommerce-mcp/dist/index.js"],
      "env": {
        "WP_URL": "https://shop.example.com",
        "WC_CONSUMER_KEY": "ck_xxx",
        "WC_CONSUMER_SECRET": "cs_xxx"
      }
    }
  }
}
```

Then ask things like *"What were last month's WooCommerce sales?"* or *"List the 5 most recent orders that are on hold."*

## Docs on wppoland.com

- [WooCommerce MCP open source (read-only): release and ops guide](https://wppoland.com/en/woocommerce-mcp-open-source-read-only/) - npm scope, registry, Glama, and how we ship updates without write tools

## Articles (off-site)

Field notes published on DEV (not duplicates of wppoland.com pages):

- [A read-only MCP server for WooCommerce: what AI agents actually need from a store](https://dev.to/wppolandcom/a-read-only-mcp-server-for-woocommerce-what-ai-agents-actually-need-from-a-store-3fk6)
- [Syncing a wholesaler's API into WooCommerce without overselling or melting the server](https://dev.to/wppolandcom/syncing-a-wholesalers-api-into-woocommerce-without-overselling-or-melting-the-server-38ao)
- [Twelve months after migrating wppoland.com from WordPress to Astro on Cloudflare Pages](https://dev.to/wppolandcom/twelve-months-after-migrating-wppolandcom-from-wordpress-to-astro-on-cloudflare-pages-11fi)

Show HN: [discussion](https://news.ycombinator.com/item?id=48815903)

## Verify

```bash
npm run check   # builds, asserts every tool registers, then runs the review-queue tests (no network/credentials needed)
npm test        # builds, then runs the tests only
```

## Notes

- Node 18+ (uses the built-in `fetch`).
- Logs go to stderr so they never corrupt the stdio MCP protocol on stdout.
- API errors are surfaced with the store's message; credentials are never echoed.

## License

MIT © [WPPoland](https://wppoland.com/en/)
