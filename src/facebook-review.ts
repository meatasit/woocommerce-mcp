/**
 * Facebook post review queue — a durable, multi-day backlog of drafted
 * Facebook posts that wait for a human to approve them.
 *
 * Why this exists: drafts are produced continuously (by an agent, a script,
 * a colleague), but the person who approves them is not always available.
 * Nothing here expires, auto-approves or auto-publishes. A post stays
 * `pending` for as long as it takes, remembers the day it entered the queue,
 * and can be reviewed days later — one by one, a whole day at a time, or the
 * entire backlog at once.
 *
 * Storage is a single JSON file (see FB_REVIEW_QUEUE_PATH). Writes are
 * atomic (temp file + rename) and a file that fails to parse is never
 * overwritten, so a backlog cannot be silently lost.
 *
 * This module is pure state management: it never talks to WooCommerce or
 * Facebook. Publishing is done by whatever consumes the `approved` posts
 * (a Facebook MCP, Postiz, a cron job, a human) and reported back with
 * `markPublished`.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const POST_STATUSES = ["pending", "approved", "rejected", "published"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const REVIEW_DECISIONS = ["approve", "reject", "reopen"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface HistoryEntry {
  at: string;
  event: string;
  detail?: string;
}

export interface QueuedPost {
  id: string;
  status: PostStatus;
  /** Local calendar day (YYYY-MM-DD, in the queue's time zone) the post entered the queue. */
  review_day: string;
  created_at: string;
  updated_at: string;
  message: string;
  image_urls: string[];
  link?: string;
  product_id?: number;
  product_name?: string;
  /** Intended publish time (ISO 8601). Informational: nothing publishes automatically. */
  scheduled_for?: string;
  /** Free-form notes from whoever queued the draft (why this post, what to check). */
  notes?: string;
  review?: { decision: "approve" | "reject"; reviewed_at: string; note?: string };
  published?: { published_at: string; facebook_post_id?: string };
  history: HistoryEntry[];
}

/** A post as returned to callers, with derived review-backlog fields. */
export interface QueuedPostView extends QueuedPost {
  /** Whole calendar days since the post entered the queue (0 = today). */
  age_days: number;
  /** True when still pending and `scheduled_for` is already in the past. */
  overdue: boolean;
}

export interface NewPostInput {
  message: string;
  image_urls?: string[];
  link?: string;
  product_id?: number;
  product_name?: string;
  scheduled_for?: string;
  notes?: string;
}

export interface PostPatch {
  message?: string;
  image_urls?: string[];
  link?: string | null;
  scheduled_for?: string | null;
  notes?: string | null;
}

export interface ListFilter {
  status?: PostStatus | "all";
  /** Inclusive YYYY-MM-DD bounds on review_day. */
  from_day?: string;
  to_day?: string;
  /** Only posts whose `scheduled_for` is at or before this ISO time (or "now"). */
  scheduled_before?: string;
  /** Only pending posts whose scheduled time has passed. */
  overdue_only?: boolean;
  order?: "oldest" | "newest";
  limit?: number;
}

export interface ReviewSelection {
  ids?: string[];
  /** Review every pending post from this review_day. */
  review_day?: string;
  /** Review every pending post, whatever the day. */
  all_pending?: boolean;
}

export interface ReviewOptions {
  note?: string;
  /** New intended publish time for the reviewed posts (useful for overdue ones). */
  scheduled_for?: string;
}

export interface BatchResult {
  updated: QueuedPostView[];
  skipped: { id: string; reason: string }[];
}

export interface QueueSummary {
  as_of: string;
  timezone: string;
  file: string;
  counts: Record<PostStatus, number>;
  pending_by_day: { review_day: string; count: number; ids: string[] }[];
  backlog_days: number;
  oldest_pending: { id: string; review_day: string; age_days: number } | null;
  overdue_pending: number;
  approved_awaiting_publish: number;
}

interface QueueFile {
  version: 1;
  posts: QueuedPost[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export function defaultQueuePath(): string {
  return path.join(os.homedir(), ".woocommerce-mcp", "facebook-review-queue.json");
}

export function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** YYYY-MM-DD for `d` in the given IANA time zone. */
export function localDay(d: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    throw new Error(`Invalid time zone "${timeZone}" (FB_REVIEW_TIMEZONE must be an IANA name such as Asia/Bangkok)`);
  }
}

function assertDay(day: string, what: string): string {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`${what} must be a calendar day formatted YYYY-MM-DD (got "${day}")`);
  }
  return day;
}

function normalizeIso(value: string, what: string): string {
  if (value.trim().toLowerCase() === "now") return new Date().toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${what} must be an ISO 8601 date-time (got "${value}")`);
  return new Date(t).toISOString();
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / MS_PER_DAY);
}

function assertImageUrls(urls: string[] | undefined): string[] {
  const list = (urls ?? []).map((u) => u.trim()).filter(Boolean);
  for (const u of list) {
    if (!/^https?:\/\//.test(u)) throw new Error(`image_urls entries must be http(s) URLs (got "${u}")`);
  }
  return list;
}

export class ReviewQueue {
  readonly filePath: string;
  readonly timeZone: string;
  private readonly now: () => Date;

  constructor(opts: { filePath?: string; timeZone?: string; now?: () => Date } = {}) {
    this.filePath = opts.filePath ?? defaultQueuePath();
    this.timeZone = opts.timeZone ?? defaultTimeZone();
    assertTimeZone(this.timeZone);
    this.now = opts.now ?? (() => new Date());
  }

  /** Build from env: FB_REVIEW_QUEUE_PATH, FB_REVIEW_TIMEZONE (both optional). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ReviewQueue {
    const filePath = (env.FB_REVIEW_QUEUE_PATH ?? "").trim() || undefined;
    const timeZone = (env.FB_REVIEW_TIMEZONE ?? "").trim() || undefined;
    return new ReviewQueue({ filePath, timeZone });
  }

  // ---- persistence -------------------------------------------------------

  private async load(): Promise<QueueFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, posts: [] };
      throw e;
    }
    if (!raw.trim()) return { version: 1, posts: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `Review queue file ${this.filePath} is not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
          "Refusing to touch it so the backlog is not lost — fix or move the file.",
      );
    }
    const file = parsed as Partial<QueueFile>;
    if (!file || !Array.isArray(file.posts)) {
      throw new Error(`Review queue file ${this.filePath} has an unexpected shape (missing "posts" array).`);
    }
    return { version: 1, posts: file.posts as QueuedPost[] };
  }

  private async save(file: QueueFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.filePath);
  }

  // ---- derived views -----------------------------------------------------

  private today(): string {
    return localDay(this.now(), this.timeZone);
  }

  private view(p: QueuedPost): QueuedPostView {
    const nowMs = this.now().getTime();
    const overdue = p.status === "pending" && !!p.scheduled_for && Date.parse(p.scheduled_for) < nowMs;
    return { ...p, age_days: daysBetween(p.review_day, this.today()), overdue };
  }

  private newId(existing: Set<string>, day: string): string {
    for (;;) {
      const id = `fb-${day.replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
      if (!existing.has(id)) return id;
    }
  }

  private stamp(p: QueuedPost, event: string, detail?: string): void {
    const at = this.now().toISOString();
    p.updated_at = at;
    p.history.push(detail ? { at, event, detail } : { at, event });
  }

  // ---- operations --------------------------------------------------------

  async add(input: NewPostInput): Promise<QueuedPostView> {
    const message = input.message.trim();
    if (!message) throw new Error("message must not be empty");
    const file = await this.load();
    const now = this.now();
    const day = localDay(now, this.timeZone);
    const post: QueuedPost = {
      id: this.newId(new Set(file.posts.map((p) => p.id)), day),
      status: "pending",
      review_day: day,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      message,
      image_urls: assertImageUrls(input.image_urls),
      history: [{ at: now.toISOString(), event: "queued" }],
    };
    if (input.link) post.link = input.link.trim();
    if (input.product_id !== undefined) post.product_id = input.product_id;
    if (input.product_name) post.product_name = input.product_name.trim();
    if (input.scheduled_for) post.scheduled_for = normalizeIso(input.scheduled_for, "scheduled_for");
    if (input.notes) post.notes = input.notes.trim();
    file.posts.push(post);
    await this.save(file);
    return this.view(post);
  }

  async get(id: string): Promise<QueuedPostView> {
    const file = await this.load();
    const post = file.posts.find((p) => p.id === id);
    if (!post) throw new Error(`No queued post with id "${id}"`);
    return this.view(post);
  }

  async list(filter: ListFilter = {}): Promise<{ total: number; returned: number; posts: QueuedPostView[] }> {
    const file = await this.load();
    const status = filter.status ?? "pending";
    const fromDay = filter.from_day ? assertDay(filter.from_day, "from_day") : undefined;
    const toDay = filter.to_day ? assertDay(filter.to_day, "to_day") : undefined;
    const scheduledBefore = filter.scheduled_before
      ? Date.parse(normalizeIso(filter.scheduled_before, "scheduled_before"))
      : undefined;

    let posts = file.posts.map((p) => this.view(p)).filter((p) => {
      if (status !== "all" && p.status !== status) return false;
      if (fromDay && p.review_day < fromDay) return false;
      if (toDay && p.review_day > toDay) return false;
      if (scheduledBefore !== undefined && (!p.scheduled_for || Date.parse(p.scheduled_for) > scheduledBefore)) return false;
      if (filter.overdue_only && !p.overdue) return false;
      return true;
    });

    // Oldest first by default: a backlog is worked in the order it arrived.
    posts.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (filter.order === "newest") posts.reverse();

    const total = posts.length;
    const limit = filter.limit ?? 50;
    posts = posts.slice(0, limit);
    return { total, returned: posts.length, posts };
  }

  async update(id: string, patch: PostPatch): Promise<QueuedPostView> {
    const file = await this.load();
    const post = file.posts.find((p) => p.id === id);
    if (!post) throw new Error(`No queued post with id "${id}"`);
    if (post.status !== "pending") {
      throw new Error(`Post ${id} is ${post.status}; only pending posts can be edited (use decision "reopen" first).`);
    }
    const changed: string[] = [];
    if (patch.message !== undefined) {
      const m = patch.message.trim();
      if (!m) throw new Error("message must not be empty");
      if (m !== post.message) {
        post.message = m;
        changed.push("message");
      }
    }
    if (patch.image_urls !== undefined) {
      post.image_urls = assertImageUrls(patch.image_urls);
      changed.push("image_urls");
    }
    if (patch.link !== undefined) {
      if (patch.link === null || !patch.link.trim()) delete post.link;
      else post.link = patch.link.trim();
      changed.push("link");
    }
    if (patch.scheduled_for !== undefined) {
      if (patch.scheduled_for === null || !patch.scheduled_for.trim()) delete post.scheduled_for;
      else post.scheduled_for = normalizeIso(patch.scheduled_for, "scheduled_for");
      changed.push("scheduled_for");
    }
    if (patch.notes !== undefined) {
      if (patch.notes === null || !patch.notes.trim()) delete post.notes;
      else post.notes = patch.notes.trim();
      changed.push("notes");
    }
    if (changed.length) {
      this.stamp(post, "edited", changed.join(", "));
      await this.save(file);
    }
    return this.view(post);
  }

  /**
   * Apply one decision to many posts at once. Posts in the wrong state are
   * reported in `skipped` instead of failing the whole batch, so catching up
   * on days of backlog never stalls on one odd item.
   */
  async review(selection: ReviewSelection, decision: ReviewDecision, opts: ReviewOptions = {}): Promise<BatchResult> {
    const file = await this.load();
    const targets = this.select(file, selection, decision === "reopen" ? ["approved", "rejected"] : ["pending"]);
    const scheduledFor = opts.scheduled_for ? normalizeIso(opts.scheduled_for, "scheduled_for") : undefined;
    const note = opts.note?.trim() || undefined;
    const result: BatchResult = { updated: [], skipped: [] };

    for (const t of targets) {
      if ("reason" in t) {
        result.skipped.push(t);
        continue;
      }
      const post = t.post;
      if (decision === "reopen") {
        post.status = "pending";
        delete post.review;
        this.stamp(post, "reopened", note);
      } else {
        post.status = decision === "approve" ? "approved" : "rejected";
        post.review = { decision, reviewed_at: this.now().toISOString(), ...(note ? { note } : {}) };
        if (scheduledFor) post.scheduled_for = scheduledFor;
        this.stamp(post, decision === "approve" ? "approved" : "rejected", note);
      }
      result.updated.push(this.view(post));
    }

    if (result.updated.length) await this.save(file);
    return result;
  }

  /** Record that approved posts went live (closes the loop; `published` is terminal). */
  async markPublished(
    ids: string[],
    info: { facebook_post_id?: string; published_at?: string } = {},
  ): Promise<BatchResult> {
    const file = await this.load();
    const targets = this.select(file, { ids }, ["approved"]);
    const publishedAt = info.published_at ? normalizeIso(info.published_at, "published_at") : this.now().toISOString();
    const result: BatchResult = { updated: [], skipped: [] };
    for (const t of targets) {
      if ("reason" in t) {
        result.skipped.push(t);
        continue;
      }
      t.post.status = "published";
      t.post.published = { published_at: publishedAt, ...(info.facebook_post_id ? { facebook_post_id: info.facebook_post_id } : {}) };
      this.stamp(t.post, "published", info.facebook_post_id);
      result.updated.push(this.view(t.post));
    }
    if (result.updated.length) await this.save(file);
    return result;
  }

  /** Permanently remove posts. Pending posts are never deleted here — reject them instead. */
  async remove(ids: string[]): Promise<{ removed: string[]; skipped: { id: string; reason: string }[] }> {
    const file = await this.load();
    const targets = this.select(file, { ids }, ["approved", "rejected", "published"]);
    const removed: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const t of targets) {
      if ("reason" in t) skipped.push(t);
      else removed.push(t.post.id);
    }
    if (removed.length) {
      file.posts = file.posts.filter((p) => !removed.includes(p.id));
      await this.save(file);
    }
    return { removed, skipped };
  }

  async summary(): Promise<QueueSummary> {
    const file = await this.load();
    const views = file.posts.map((p) => this.view(p));
    const counts: Record<PostStatus, number> = { pending: 0, approved: 0, rejected: 0, published: 0 };
    const byDay = new Map<string, string[]>();
    for (const v of views) {
      counts[v.status]++;
      if (v.status === "pending") byDay.set(v.review_day, [...(byDay.get(v.review_day) ?? []), v.id]);
    }
    const pending_by_day = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([review_day, ids]) => ({ review_day, count: ids.length, ids }));
    const oldest = views
      .filter((v) => v.status === "pending")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    return {
      as_of: this.now().toISOString(),
      timezone: this.timeZone,
      file: this.filePath,
      counts,
      pending_by_day,
      backlog_days: pending_by_day.length,
      oldest_pending: oldest ? { id: oldest.id, review_day: oldest.review_day, age_days: oldest.age_days } : null,
      overdue_pending: views.filter((v) => v.overdue).length,
      approved_awaiting_publish: counts.approved,
    };
  }

  // ---- helpers -----------------------------------------------------------

  /** Resolve a selection to concrete posts, tagging those in a disallowed state. */
  private select(
    file: QueueFile,
    selection: ReviewSelection,
    allowed: PostStatus[],
  ): Array<{ post: QueuedPost } | { id: string; reason: string }> {
    const hasIds = !!selection.ids?.length;
    if (!hasIds && !selection.review_day && !selection.all_pending) {
      throw new Error("Select posts with ids, review_day, or all_pending=true");
    }
    const out: Array<{ post: QueuedPost } | { id: string; reason: string }> = [];
    const seen = new Set<string>();
    const consider = (post: QueuedPost) => {
      if (seen.has(post.id)) return;
      seen.add(post.id);
      if (allowed.includes(post.status)) out.push({ post });
      else out.push({ id: post.id, reason: `status is ${post.status}; expected ${allowed.join(" or ")}` });
    };

    for (const id of selection.ids ?? []) {
      const post = file.posts.find((p) => p.id === id);
      if (!post) {
        if (!seen.has(id)) out.push({ id, reason: "not found" });
        seen.add(id);
        continue;
      }
      consider(post);
    }
    if (selection.review_day) {
      const day = assertDay(selection.review_day, "review_day");
      for (const post of file.posts) if (post.review_day === day && post.status === "pending") consider(post);
    }
    if (selection.all_pending) {
      for (const post of file.posts) if (post.status === "pending") consider(post);
    }
    // Work oldest first so batch results read in backlog order.
    out.sort((a, b) => {
      const ca = "post" in a ? a.post.created_at : "";
      const cb = "post" in b ? b.post.created_at : "";
      return ca.localeCompare(cb);
    });
    return out;
  }
}
