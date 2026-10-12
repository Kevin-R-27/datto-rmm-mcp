/**
 * Coverage for datto_list_activity_logs.
 *
 * Two layers: the pure helpers in activity-logs.ts (argument validation,
 * defaults, response normalisation), and a real tools/call round-trip through
 * the Worker `fetch` entrypoint with only the Datto host stubbed - the same
 * technique as job-tools.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../worker.js";
import {
  buildActivityLogQuery,
  extractNextCursor,
  normalizeActivity,
  normalizeDate,
} from "../activity-logs.js";

const DATTO_HOST = "https://concord-api.centrastage.net";
const ENV = { DATTO_API_KEY: "test-key", DATTO_API_SECRET: "test-secret" };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("buildActivityLogQuery", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("defaults to the last 24h, newest first, DEVICE only, 50 rows", () => {
    const q = buildActivityLogQuery({}, [], now);
    expect(q.until).toBe("2026-10-12T12:00:00Z");
    expect(q.from).toBe("2026-10-11T12:00:00Z");
    expect(q.entities).toEqual(["DEVICE"]);
    expect(q.order).toBe("desc");
    expect(q.max).toBe(50);
    expect(q.siteIds).toEqual([]);
  });

  it("caps max at 250 and accepts comma strings for list filters", () => {
    const q = buildActivityLogQuery({ max: 9999, categories: "job, patch", entities: "device,user" }, [], now);
    expect(q.max).toBe(250);
    expect(q.categories).toEqual(["job", "patch"]);
    expect(q.entities).toEqual(["DEVICE", "USER"]);
  });

  it("drops fractional seconds from from/until", () => {
    const q = buildActivityLogQuery({ from: "2026-10-01T00:00:00.123Z", until: "2026-10-02T00:00:00Z" }, [], now);
    expect(q.from).toBe("2026-10-01T00:00:00Z");
  });

  it("merges explicit and resolved site ids without duplicates", () => {
    const q = buildActivityLogQuery({ siteIds: [5, 7] }, [7, 9], now);
    expect(q.siteIds).toEqual([5, 7, 9]);
  });

  it.each([
    [{ from: "not-a-date" }, /ISO 8601/],
    [{ from: "2026-10-03T00:00:00Z", until: "2026-10-02T00:00:00Z" }, /later than/],
    [{ entities: ["SITE"] }, /DEVICE and\/or USER/],
    [{ order: "sideways" }, /asc/],
    [{ siteIds: ["a1b2c3d4-uid"] }, /numeric ids/],
    [{ userIds: [-1] }, /numeric ids/],
    [{ max: 0 }, /positive/],
  ])("rejects bad input %j", (args, message) => {
    expect(() => buildActivityLogQuery(args, [], now)).toThrow(message);
  });
});

describe("normalizeDate", () => {
  it("handles epoch seconds, epoch milliseconds and ISO strings", () => {
    expect(normalizeDate(1706745600)).toBe("2024-02-01T00:00:00.000Z");
    expect(normalizeDate(1706745600000)).toBe("2024-02-01T00:00:00.000Z");
    expect(normalizeDate("2024-02-01T00:00:00Z")).toBe("2024-02-01T00:00:00.000Z");
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate("garbage")).toBeNull();
  });
});

describe("normalizeActivity / extractNextCursor", () => {
  it("flattens an entry and parses JSON-string details", () => {
    const row = normalizeActivity({
      id: "a1",
      entity: "DEVICE",
      category: "job",
      action: "deployment",
      date: 1706745600,
      site: { id: 10, name: "HQ" },
      deviceId: 55,
      hostname: "PC-1",
      user: { id: 3, userName: "ada", firstName: "Ada", lastName: "L" },
      details: '{"jobName":"Cleanup"}',
      hasStdOut: true,
    });
    expect(row.date).toBe("2024-02-01T00:00:00.000Z");
    expect(row.device).toEqual({ id: 55, hostname: "PC-1" });
    expect(row.user).toEqual({ id: 3, userName: "ada", name: "Ada L" });
    expect(row.details).toEqual({ jobName: "Cleanup" });
    expect(row.hasStdOut).toBe(true);
    expect(row.hasStdErr).toBe(false);
  });

  it("keeps non-JSON details as text and tolerates missing parts", () => {
    const row = normalizeActivity({ details: "plain text" });
    expect(row.details).toBe("plain text");
    expect(row.site).toBeNull();
    expect(row.device).toBeNull();
    expect(row.user).toBeNull();
  });

  it("extracts the searchAfter cursor from nextPageUrl", () => {
    expect(
      extractNextCursor(`${DATTO_HOST}/api/v2/activity-logs?searchAfter=1789334240335%2Cb76ab24d&order=desc`)
    ).toBe("1789334240335,b76ab24d");
    expect(extractNextCursor(null)).toBeNull();
  });
});

async function call(name: string, args: Record<string, unknown>) {
  return worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    ENV
  );
}

function stubFetch(handler: (url: string) => Response | undefined) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${DATTO_HOST}/auth/oauth/token`)) {
      return new Response(
        JSON.stringify({ access_token: "fake-token", token_type: "bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    const stubbed = handler(url);
    if (stubbed) return stubbed;
    throw new Error(`Unstubbed fetch in test: GET ${url}`);
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Unwraps the <datto-data> marker envelope and parses the JSON inside. */
function parseResult(text: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(text.slice(start, end + 1));
}

async function resultText(res: Response): Promise<string> {
  const body = (await res.json()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
  };
  expect(body.result?.isError).toBeFalsy();
  return body.result?.content?.[0]?.text ?? "";
}

describe("datto_list_activity_logs", () => {
  it("is advertised as read-only", async () => {
    const res = await worker.fetch(
      new Request("http://worker.local/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      ENV
    );
    const body = (await res.json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    const tool = body.result.tools.find((t) => t.name === "datto_list_activity_logs");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("sends the filters Datto documents and returns normalised rows plus a cursor", async () => {
    let seen: URL | undefined;
    stubFetch((url) => {
      if (url.startsWith(`${DATTO_HOST}/api/v2/activity-logs`)) {
        seen = new URL(url);
        return json({
          pageDetails: {
            count: 1,
            prevPageUrl: null,
            nextPageUrl: `${DATTO_HOST}/api/v2/activity-logs?searchAfter=111%2Cabc&order=desc`,
          },
          activities: [
            {
              id: "a1",
              entity: "DEVICE",
              category: "job",
              action: "deployment",
              date: 1706745600,
              site: { id: 10, name: "HQ" },
              deviceId: 55,
              hostname: "PC-1",
              user: { id: 3, userName: "ada" },
              details: '{"jobName":"Cleanup"}',
              hasStdOut: true,
              hasStdErr: false,
            },
          ],
        });
      }
      return undefined;
    });

    const res = await call("datto_list_activity_logs", {
      from: "2026-10-11T00:00:00Z",
      until: "2026-10-12T00:00:00Z",
      categories: ["job", "patch"],
      siteIds: [10, 11],
      userIds: [3],
      max: 25,
    });
    const out = parseResult(await resultText(res));

    expect(seen?.searchParams.get("from")).toBe("2026-10-11T00:00:00Z");
    expect(seen?.searchParams.get("until")).toBe("2026-10-12T00:00:00Z");
    expect(seen?.searchParams.get("categories")).toBe("job,patch");
    expect(seen?.searchParams.get("entities")).toBe("DEVICE");
    expect(seen?.searchParams.get("siteIds")).toBe("10,11");
    expect(seen?.searchParams.get("userIds")).toBe("3");
    expect(seen?.searchParams.get("order")).toBe("desc");
    expect(seen?.searchParams.get("size")).toBe("25");

    expect(out.count).toBe(1);
    expect(out.nextCursor).toBe("111,abc");
    expect(out.activities[0].date).toBe("2024-02-01T00:00:00.000Z");
    expect(out.activities[0].details).toEqual({ jobName: "Cleanup" });
    expect(out.activities[0].device.hostname).toBe("PC-1");
  });

  it("passes the cursor back as searchAfter", async () => {
    let seen: URL | undefined;
    stubFetch((url) => {
      if (url.startsWith(`${DATTO_HOST}/api/v2/activity-logs`)) {
        seen = new URL(url);
        return json({ pageDetails: { count: 0, nextPageUrl: null }, activities: [] });
      }
      return undefined;
    });

    const res = await call("datto_list_activity_logs", { cursor: "111,abc" });
    const out = parseResult(await resultText(res));

    expect(seen?.searchParams.get("searchAfter")).toBe("111,abc");
    expect(out.nextCursor).toBeNull();
    expect(out.activities).toEqual([]);
  });

  it("resolves siteUids to numeric site ids", async () => {
    let seen: URL | undefined;
    stubFetch((url) => {
      if (url === `${DATTO_HOST}/api/v2/site/site-uid-1`) {
        return json({ uid: "site-uid-1", id: 4242, name: "HQ" });
      }
      if (url.startsWith(`${DATTO_HOST}/api/v2/activity-logs`)) {
        seen = new URL(url);
        return json({ pageDetails: { count: 0, nextPageUrl: null }, activities: [] });
      }
      return undefined;
    });

    await resultText(await call("datto_list_activity_logs", { siteUids: ["site-uid-1"] }));
    expect(seen?.searchParams.get("siteIds")).toBe("4242");
  });

  it("returns an error result for an invalid time range", async () => {
    stubFetch(() => undefined);
    const res = await call("datto_list_activity_logs", { from: "yesterday-ish" });
    const body = (await res.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/ISO 8601/);
  });
});
