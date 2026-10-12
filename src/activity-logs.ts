/**
 * Helpers for datto_list_activity_logs.
 *
 * Kept separate from mcp-server.ts so the argument handling and response
 * normalisation can be unit-tested without a transport.
 *
 * Verified vs assumed: `categories`, `actions` and `entities` were verified
 * against a live tenant (node-datto-rmm#82). `from`, `until`, `siteIds`,
 * `userIds`, `order` and `size` follow Datto's documented GET /v2/activity-logs
 * and the DattoRMM.Core client, and have NOT been live-verified here.
 */

/** Hard ceiling on one page; Datto's documented maximum page size. */
export const ACTIVITY_LOG_MAX_PAGE = 250;
/** Default page size when the caller does not ask for one. */
export const ACTIVITY_LOG_DEFAULT_MAX = 50;
/** Default look-back when `from` is omitted. */
export const ACTIVITY_LOG_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Entities the API distinguishes. */
export const ACTIVITY_LOG_ENTITIES = ["DEVICE", "USER"] as const;

export interface ActivityLogToolArgs {
  from?: string;
  until?: string;
  categories?: string[] | string;
  actions?: string[] | string;
  entities?: string[] | string;
  siteIds?: Array<number | string>;
  siteUids?: string[];
  userIds?: Array<number | string>;
  order?: string;
  max?: number;
  cursor?: string;
}

/** Accepts `["a","b"]` or `"a,b"`; returns trimmed, de-duplicated, non-empty values. */
export function toList(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : value.split(",");
  return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
}

function toIso(value: string, label: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} must be an ISO 8601 date-time, got "${value}"`);
  }
  // Datto documents second precision: yyyy-MM-ddTHH:mm:ssZ.
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toIds(values: Array<number | string> | undefined, label: string): number[] {
  if (!values) return [];
  return values.map((v) => {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${label} must be numeric ids (not UIDs), got "${String(v)}"`);
    }
    return n;
  });
}

export interface ActivityLogQuery {
  from: string;
  until: string;
  entities: string[];
  categories?: string[];
  actions?: string[];
  userIds?: number[];
  siteIds: number[];
  order: "asc" | "desc";
  max: number;
  size: number;
  cursor?: string;
}

/**
 * Validates tool arguments and applies defaults. Site UIDs are resolved by
 * the caller (they need API calls) and passed in as `resolvedSiteIds`.
 */
export function buildActivityLogQuery(
  args: ActivityLogToolArgs,
  resolvedSiteIds: number[] = [],
  now: Date = new Date()
): ActivityLogQuery {
  const until = args.until ? toIso(args.until, "until") : toIso(now.toISOString(), "until");
  const from = args.from
    ? toIso(args.from, "from")
    : toIso(new Date(Date.parse(until) - ACTIVITY_LOG_DEFAULT_WINDOW_MS).toISOString(), "from");
  if (Date.parse(from) > Date.parse(until)) {
    throw new Error("from must not be later than until");
  }

  const entities = (args.entities === undefined ? ["DEVICE"] : toList(args.entities)).map((e) =>
    e.toUpperCase()
  );
  for (const e of entities) {
    if (!(ACTIVITY_LOG_ENTITIES as readonly string[]).includes(e)) {
      throw new Error(`entities must be DEVICE and/or USER, got "${e}"`);
    }
  }

  const order = (args.order ?? "desc").toLowerCase();
  if (order !== "asc" && order !== "desc") {
    throw new Error(`order must be "asc" or "desc", got "${args.order}"`);
  }

  const requested = args.max ?? ACTIVITY_LOG_DEFAULT_MAX;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("max must be a positive number");
  }
  const max = Math.min(Math.floor(requested), ACTIVITY_LOG_MAX_PAGE);

  const categories = toList(args.categories);
  const actions = toList(args.actions);
  const userIds = toIds(args.userIds, "userIds");
  const siteIds = [...new Set([...toIds(args.siteIds, "siteIds"), ...resolvedSiteIds])];

  return {
    from,
    until,
    entities: [...new Set(entities)],
    categories: categories.length ? categories : undefined,
    actions: actions.length ? actions : undefined,
    userIds: userIds.length ? userIds : undefined,
    siteIds,
    order,
    max,
    size: max,
    cursor: args.cursor?.trim() || undefined,
  };
}

/** Epoch seconds, epoch milliseconds or an ISO string -> ISO string (null if unusable). */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let ms: number;
  if (typeof value === "number") {
    ms = Math.abs(value) < 1e11 ? value * 1000 : value;
  } else if (typeof value === "string") {
    if (/^-?\d+(\.\d+)?$/.test(value.trim())) return normalizeDate(Number(value));
    ms = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** The API may return `details` as a JSON string; parse it when it is one. */
export function parseDetails(details: unknown): unknown {
  if (typeof details !== "string") return details ?? null;
  const trimmed = details.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return details;
  }
}

export interface ActivityLogRow {
  id?: string;
  date: string | null;
  entity?: string;
  category?: string;
  action?: string;
  site: { id?: number; name?: string } | null;
  device: { id?: number; hostname?: string } | null;
  user: { id?: number; userName?: string; name?: string } | null;
  details: unknown;
  hasStdOut: boolean;
  hasStdErr: boolean;
}

/** One API entry -> a flat, stable row for the model. */
export function normalizeActivity(raw: unknown): ActivityLogRow {
  const a = (raw ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const user = a.user as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fullName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined
    : undefined;
  return {
    id: a.id,
    date: normalizeDate(a.date),
    entity: a.entity,
    category: a.category,
    action: a.action,
    site: a.site ? { id: a.site.id, name: a.site.name } : null,
    device:
      a.deviceId !== undefined || a.hostname
        ? { id: a.deviceId, hostname: a.hostname }
        : null,
    user: user ? { id: user.id, userName: user.userName, name: fullName } : null,
    details: parseDetails(a.details),
    hasStdOut: Boolean(a.hasStdOut),
    hasStdErr: Boolean(a.hasStdErr),
  };
}

/** Pulls the `searchAfter` cursor out of pageDetails.nextPageUrl, if any. */
export function extractNextCursor(nextPageUrl: string | null | undefined): string | null {
  if (!nextPageUrl) return null;
  try {
    return new URL(nextPageUrl).searchParams.get("searchAfter");
  } catch {
    return null;
  }
}
