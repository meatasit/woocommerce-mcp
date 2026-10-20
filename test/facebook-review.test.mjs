// Facebook review queue: the multi-day backlog behaviour, end to end.
// Run: npm test  (builds first, then node --test).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReviewQueue, localDay } from "../dist/facebook-review.js";
import { createServer } from "../dist/index.js";

const TZ = "Asia/Bangkok";

/** A queue in a temp dir with a controllable clock. */
async function makeQueue(startIso = "2026-10-13T02:00:00Z") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-review-"));
  const clock = { now: new Date(startIso) };
  const queue = new ReviewQueue({
    filePath: path.join(dir, "queue.json"),
    timeZone: TZ,
    now: () => clock.now,
  });
  const advanceDays = (n) => {
    clock.now = new Date(clock.now.getTime() + n * 86_400_000);
  };
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { queue, clock, advanceDays, cleanup, dir };
}

test("localDay uses the queue time zone, not UTC", () => {
  // 23:30 UTC on the 13th is already the 14th in Bangkok (UTC+7).
  assert.equal(localDay(new Date("2026-10-13T23:30:00Z"), TZ), "2026-10-14");
  assert.equal(localDay(new Date("2026-10-13T23:30:00Z"), "UTC"), "2026-10-13");
});

test("posts accumulate over several days and are listed oldest first with their age", async () => {
  const { queue, advanceDays, cleanup } = await makeQueue();
  try {
    const a = await queue.add({ message: "Day 1 post", product_id: 11 });
    advanceDays(1);
    const b = await queue.add({ message: "Day 2 post" });
    advanceDays(1);
    const c = await queue.add({ message: "Day 3 post", scheduled_for: "2026-10-15T03:00:00Z" });
    advanceDays(2); // now day 5; c's scheduled time has passed

    assert.equal(a.review_day, "2026-10-13");
    assert.equal(b.review_day, "2026-10-14");
    assert.equal(c.review_day, "2026-10-15");

    const { total, posts } = await queue.list();
    assert.equal(total, 3);
    assert.deepEqual(posts.map((p) => p.id), [a.id, b.id, c.id]);
    assert.deepEqual(posts.map((p) => p.age_days), [4, 3, 2]);
    assert.deepEqual(posts.map((p) => p.overdue), [false, false, true]);
    assert.equal(posts[0].product_id, 11);

    const overdue = await queue.list({ overdue_only: true });
    assert.deepEqual(overdue.posts.map((p) => p.id), [c.id]);

    const window = await queue.list({ from_day: "2026-10-14", to_day: "2026-10-14" });
    assert.deepEqual(window.posts.map((p) => p.id), [b.id]);

    const newest = await queue.list({ order: "newest", limit: 1 });
    assert.equal(newest.total, 3);
    assert.deepEqual(newest.posts.map((p) => p.id), [c.id]);
  } finally {
    await cleanup();
  }
});

test("summary groups the backlog by day and flags overdue / oldest", async () => {
  const { queue, advanceDays, cleanup } = await makeQueue();
  try {
    const a = await queue.add({ message: "one" });
    const b = await queue.add({ message: "two", scheduled_for: "2026-10-13T10:00:00Z" });
    advanceDays(3);
    const c = await queue.add({ message: "three" });
    await queue.review({ ids: [c.id] }, "approve");

    const s = await queue.summary();
    assert.equal(s.timezone, TZ);
    assert.deepEqual(s.counts, { pending: 2, approved: 1, rejected: 0, published: 0 });
    assert.deepEqual(s.pending_by_day, [{ review_day: "2026-10-13", count: 2, ids: [a.id, b.id] }]);
    assert.equal(s.backlog_days, 1);
    assert.deepEqual(s.oldest_pending, { id: a.id, review_day: "2026-10-13", age_days: 3 });
    assert.equal(s.overdue_pending, 1);
    assert.equal(s.approved_awaiting_publish, 1);
  } finally {
    await cleanup();
  }
});

test("batch review by ids, by day, and all_pending; wrong states are skipped not fatal", async () => {
  const { queue, advanceDays, cleanup } = await makeQueue();
  try {
    const d1a = await queue.add({ message: "d1 a" });
    const d1b = await queue.add({ message: "d1 b" });
    advanceDays(1);
    const d2 = await queue.add({ message: "d2" });
    advanceDays(1);
    const d3 = await queue.add({ message: "d3" });

    // Approve a whole day at once.
    const byDay = await queue.review({ review_day: "2026-10-13" }, "approve", { note: "looks good" });
    assert.deepEqual(byDay.updated.map((p) => p.id), [d1a.id, d1b.id]);
    assert.equal(byDay.updated[0].status, "approved");
    assert.equal(byDay.updated[0].review.note, "looks good");
    assert.deepEqual(byDay.skipped, []);

    // Mixed batch: one pending, one already approved, one unknown.
    const mixed = await queue.review({ ids: [d2.id, d1a.id, "fb-nope"] }, "reject", { note: "old promo" });
    assert.deepEqual(mixed.updated.map((p) => p.id), [d2.id]);
    assert.equal(mixed.updated[0].status, "rejected");
    assert.deepEqual(
      mixed.skipped.map((s) => s.id).sort(),
      [d1a.id, "fb-nope"].sort(),
    );
    assert.ok(mixed.skipped.find((s) => s.id === "fb-nope").reason.includes("not found"));
    assert.ok(mixed.skipped.find((s) => s.id === d1a.id).reason.includes("approved"));

    // Reopen a rejected post, then clear the whole remaining backlog with a new schedule.
    const reopened = await queue.review({ ids: [d2.id] }, "reopen");
    assert.equal(reopened.updated[0].status, "pending");
    assert.equal(reopened.updated[0].review, undefined);

    const all = await queue.review({ all_pending: true }, "approve", { scheduled_for: "2026-10-20T03:00:00Z" });
    assert.deepEqual(all.updated.map((p) => p.id), [d2.id, d3.id]);
    assert.equal(all.updated[1].scheduled_for, "2026-10-20T03:00:00.000Z");

    const s = await queue.summary();
    assert.deepEqual(s.counts, { pending: 0, approved: 4, rejected: 0, published: 0 });

    await assert.rejects(() => queue.review({}, "approve"), /ids, review_day, or all_pending/);
  } finally {
    await cleanup();
  }
});

test("edit only while pending; publish closes the loop; delete never touches pending", async () => {
  const { queue, cleanup } = await makeQueue();
  try {
    const p = await queue.add({ message: "draft", link: "https://shop.example.com/p/1", notes: "check price" });
    const edited = await queue.update(p.id, { message: "final caption", link: "", image_urls: ["https://img.example.com/a.jpg"] });
    assert.equal(edited.message, "final caption");
    assert.equal(edited.link, undefined);
    assert.deepEqual(edited.image_urls, ["https://img.example.com/a.jpg"]);
    assert.ok(edited.history.some((h) => h.event === "edited" && h.detail.includes("message")));

    await queue.review({ ids: [p.id] }, "approve");
    await assert.rejects(() => queue.update(p.id, { message: "too late" }), /only pending posts can be edited/);

    const del = await queue.remove([p.id, "fb-missing"]);
    // Approved posts may be deleted; unknown ids are reported, not fatal.
    assert.deepEqual(del.removed, [p.id]);

    const p2 = await queue.add({ message: "second" });
    const noDelete = await queue.remove([p2.id]);
    assert.deepEqual(noDelete.removed, []);
    assert.match(noDelete.skipped[0].reason, /pending/);

    await queue.review({ ids: [p2.id] }, "approve");
    const pub = await queue.markPublished([p2.id], { facebook_post_id: "123_456" });
    assert.equal(pub.updated[0].status, "published");
    assert.equal(pub.updated[0].published.facebook_post_id, "123_456");
    const again = await queue.markPublished([p2.id]);
    assert.equal(again.updated.length, 0);
    assert.match(again.skipped[0].reason, /published/);
  } finally {
    await cleanup();
  }
});

test("state survives a restart and a corrupt file is never overwritten", async () => {
  const { queue, dir, cleanup } = await makeQueue();
  try {
    const p = await queue.add({ message: "persisted", image_urls: ["https://img.example.com/x.png"] });
    const fresh = new ReviewQueue({ filePath: queue.filePath, timeZone: TZ });
    const got = await fresh.get(p.id);
    assert.equal(got.message, "persisted");
    assert.equal(got.status, "pending");

    await writeFile(queue.filePath, "{ not json", "utf8");
    await assert.rejects(() => fresh.add({ message: "x" }), /not valid JSON/);
    assert.equal(await readFile(queue.filePath, "utf8"), "{ not json");

    const missing = new ReviewQueue({ filePath: path.join(dir, "nested", "dir", "q.json"), timeZone: TZ });
    assert.equal((await missing.list()).total, 0);
    await missing.add({ message: "creates parent dirs" });
    assert.equal((await missing.list()).total, 1);
  } finally {
    await cleanup();
  }
});

test("rejects bad input: empty message, non-http images, bad time zone, bad dates", async () => {
  const { queue, cleanup } = await makeQueue();
  try {
    await assert.rejects(() => queue.add({ message: "   " }), /message must not be empty/);
    await assert.rejects(() => queue.add({ message: "x", image_urls: ["ftp://nope"] }), /http\(s\) URLs/);
    await assert.rejects(() => queue.add({ message: "x", scheduled_for: "tomorrow-ish" }), /ISO 8601/);
    await assert.rejects(() => queue.list({ from_day: "13/10/2026" }), /YYYY-MM-DD/);
    assert.throws(() => new ReviewQueue({ filePath: queue.filePath, timeZone: "Mars/Olympus" }), /Invalid time zone/);
  } finally {
    await cleanup();
  }
});

test("tools work end to end over MCP", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-review-mcp-"));
  const prevPath = process.env.FB_REVIEW_QUEUE_PATH;
  const prevTz = process.env.FB_REVIEW_TIMEZONE;
  process.env.FB_REVIEW_QUEUE_PATH = path.join(dir, "queue.json");
  process.env.FB_REVIEW_TIMEZONE = TZ;
  try {
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content[0].text;
      if (res.isError) throw new Error(text);
      return JSON.parse(text);
    };

    const queued = await call("queue_facebook_post", {
      message: "โปรโมชั่นสินค้าใหม่ 🎉",
      product_id: 42,
      product_name: "Sample Tee",
      image_urls: ["https://shop.example.com/wp-content/uploads/tee.jpg"],
      notes: "เช็คราคาก่อนโพส",
    });
    assert.equal(queued.status, "pending");
    assert.match(queued.id, /^fb-\d{8}-[0-9a-f]{6}$/);

    const listed = await call("list_facebook_posts", {});
    assert.equal(listed.total, 1);
    assert.equal(listed.posts[0].product_name, "Sample Tee");

    const summary = await call("facebook_review_summary", {});
    assert.equal(summary.counts.pending, 1);
    assert.equal(summary.backlog_days, 1);

    const reviewed = await call("review_facebook_posts", { decision: "approve", all_pending: true, note: "ok" });
    assert.equal(reviewed.updated_count, 1);
    assert.equal(reviewed.skipped_count, 0);

    const published = await call("mark_facebook_post_published", { ids: [queued.id], facebook_post_id: "1_2" });
    assert.equal(published.updated[0].status, "published");

    const detail = await call("get_facebook_post", { id: queued.id });
    assert.deepEqual(detail.history.map((h) => h.event), ["queued", "approved", "published"]);

    // Errors come back as isError tool results, not protocol failures.
    await assert.rejects(() => call("get_facebook_post", { id: "fb-missing" }), /No queued post/);

    await client.close();
    await server.close();
  } finally {
    if (prevPath === undefined) delete process.env.FB_REVIEW_QUEUE_PATH;
    else process.env.FB_REVIEW_QUEUE_PATH = prevPath;
    if (prevTz === undefined) delete process.env.FB_REVIEW_TIMEZONE;
    else process.env.FB_REVIEW_TIMEZONE = prevTz;
    await rm(dir, { recursive: true, force: true });
  }
});
