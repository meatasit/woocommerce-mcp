// Smoke check: the server constructs and registers all its tools without needing
// credentials or a network. Fails loudly if the SDK API or tool wiring breaks.
// Run: npm run check  (builds first, then this).
import assert from "node:assert";
import { createServer, VERSION } from "../dist/index.js";

const server = createServer();
assert.ok(server, "createServer() returned nothing");
assert.match(VERSION, /^\d+\.\d+\.\d+$/, "VERSION is not semver");

// The registered tool names live on the underlying server's tool registry.
// Reach in defensively so the check survives minor SDK shape changes.
const reg =
  server._registeredTools ??
  server.server?._registeredTools ??
  {};
const names = Object.keys(reg);

const expected = [
  // store (read-only)
  "list_products", "get_product", "list_orders", "sales_report", "search_posts",
  // Facebook post review backlog (local JSON file)
  "queue_facebook_post", "list_facebook_posts", "get_facebook_post", "update_facebook_post",
  "review_facebook_posts", "mark_facebook_post_published", "delete_facebook_posts", "facebook_review_summary",
];
for (const t of expected) {
  assert.ok(names.includes(t), `tool "${t}" not registered (found: ${names.join(", ") || "none"})`);
}

console.log(`OK woocommerce-mcp v${VERSION} — ${names.length} tools registered: ${names.join(", ")}`);
