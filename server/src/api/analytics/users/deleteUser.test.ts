import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DeleteCommand = { query: string; query_params: { siteId: number; userId: string; deviceIds: string[] } };

const mocks = vi.hoisted(() => ({
  aliases: [] as { anonymousId: string }[],
  aliasWhere: vi.fn(),
  deleteWhere: vi.fn(),
  command: vi.fn(),
  query: vi.fn(),
  isEnabled: vi.fn(),
  deleteBatch: vi.fn(),
  clearAttributions: vi.fn(),
}));

vi.mock("../../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: { command: mocks.command, query: mocks.query },
}));
vi.mock("../../../db/postgres/postgres.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.aliasWhere }) }),
    delete: (table: unknown) => ({ where: (condition: unknown) => mocks.deleteWhere(table, condition) }),
  },
}));
vi.mock("../../../db/postgres/schema.js", () => ({
  userProfiles: { siteId: "profiles.siteId", userId: "profiles.userId" },
  userAliases: { siteId: "aliases.siteId", anonymousId: "aliases.anonymousId", userId: "aliases.userId" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  or: (...conditions: unknown[]) => ({ or: conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));
vi.mock("../../../services/storage/r2StorageService.js", () => ({
  r2Storage: { isEnabled: mocks.isEnabled, deleteBatch: mocks.deleteBatch },
}));
vi.mock("../../../services/heatmaps/heatmapBatchClaims.js", () => ({
  heatmapBatchClaims: { clearAttributions: mocks.clearAttributions },
}));
vi.mock("../utils/utils.js", () => ({ processResults: (result: { json: () => Promise<unknown[]> }) => result.json() }));

import { deleteUser } from "./deleteUser.js";

function request(userId = "alice", siteId = "1") {
  return { params: { siteId, userId }, log: { error: vi.fn() } };
}

function reply() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
}

function heatmapDelete(): DeleteCommand {
  const command = mocks.command.mock.calls
    .map(([value]) => value as DeleteCommand)
    .find(value => value.query.startsWith("DELETE FROM heatmap_events "));
  if (!command) throw new Error("The erasure handler did not delete heatmap_events");
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.aliases = [];
  mocks.aliasWhere.mockImplementation(async () => mocks.aliases);
  mocks.deleteWhere.mockResolvedValue(undefined);
  mocks.command.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ json: async () => [] });
  mocks.isEnabled.mockReturnValue(false);
  mocks.deleteBatch.mockResolvedValue(undefined);
  mocks.clearAttributions.mockResolvedValue(undefined);
});

describe("deleteUser heatmap erasure", () => {
  it("deletes every interaction table with a site-bound, parameterized shared-device guard", async () => {
    mocks.aliases = [{ anonymousId: "dev-shared" }, { anonymousId: "dev-other" }];
    const res = reply();
    await deleteUser(request() as never, res as never);

    expect(res.payload).toEqual({ success: true });
    expect(mocks.command).toHaveBeenCalledTimes(4);
    expect(mocks.clearAttributions).toHaveBeenCalledWith(1, "alice", ["alice", "dev-shared", "dev-other"]);
    expect(mocks.clearAttributions.mock.invocationCallOrder[0]).toBeLessThan(mocks.command.mock.invocationCallOrder[0]);
    expect(mocks.command.mock.calls.map(([value]) => value.query.split(" ")[2])).toEqual([
      "events",
      "session_replay_events",
      "session_replay_metadata_v2",
      "heatmap_events",
    ]);
    const deletion = heatmapDelete();
    expect(deletion.query).toMatch(/site_id = \{siteId:UInt32\}\s+AND/);
    expect(deletion.query).toMatch(/identified_user_id = \{userId:String\}/);
    expect(deletion.query).toMatch(/user_id IN \(\{deviceIds:Array\(String\)\}\) AND identified_user_id = ''/);
    expect(deletion.query_params).toEqual({
      siteId: 1,
      userId: "alice",
      deviceIds: ["alice", "dev-shared", "dev-other"],
    });
    expect(mocks.aliasWhere).toHaveBeenCalledWith({
      and: [
        { column: "aliases.siteId", value: 1 },
        { column: "aliases.userId", value: "alice" },
      ],
    });
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
    for (const [, condition] of mocks.deleteWhere.mock.calls) {
      expect(condition.and[0]).toMatchObject({ value: 1 });
    }
  });

  it("keeps raw user IDs in parameters, including IDs with SQL syntax", async () => {
    const userId = "alice' OR site_id != 1 --";
    const res = reply();
    await deleteUser(request(userId, "7") as never, res as never);

    const deletion = heatmapDelete();
    expect(deletion.query).not.toContain(userId);
    expect(deletion.query_params).toEqual({ siteId: 7, userId, deviceIds: [userId] });
    expect(res.statusCode).toBe(200);
  });

  it("continues heatmap erasure when cloud replay payload cleanup fails", async () => {
    mocks.isEnabled.mockReturnValue(true);
    mocks.query.mockResolvedValue({ json: async () => [{ event_data_key: "site-1/replay" }] });
    mocks.deleteBatch.mockRejectedValue(new Error("Object storage unavailable"));
    const req = request();
    const res = reply();
    await deleteUser(req as never, res as never);

    expect(heatmapDelete().query_params.siteId).toBe(1);
    expect(mocks.command).toHaveBeenCalledTimes(4);
    expect(req.log.error).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({ success: true });
  });

  it("does not report success or remove aliases if a heatmap deletion fails", async () => {
    mocks.command.mockImplementation(async ({ query }: DeleteCommand) => {
      if (query.startsWith("DELETE FROM heatmap_events ")) throw new Error("ClickHouse unavailable");
    });
    const req = request();
    const res = reply();
    await deleteUser(req as never, res as never);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({ error: "Failed to delete user" });
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(req.log.error).toHaveBeenCalledTimes(1);
  });

  it("fails erasure closed before deleting data if retry attribution cannot be cleared", async () => {
    mocks.clearAttributions.mockRejectedValueOnce(new Error("Redis unavailable"));
    const res = reply();
    await deleteUser(request() as never, res as never);
    expect(res.statusCode).toBe(500);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });
});

// Execute the exact predicate emitted by the handler. The fixture is a CTE,
// so these checks never create tables or mutate any database data.
describe.skipIf(!process.env.CLICKHOUSE_TEST_URL)("deleteUser heatmap predicate against ClickHouse", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(() => {
    client = createClient({
      url: process.env.CLICKHOUSE_TEST_URL,
      username: process.env.CLICKHOUSE_TEST_USER || "default",
      password: process.env.CLICKHOUSE_TEST_PASSWORD || "",
      compression: { request: false, response: false },
      clickhouse_settings: { readonly: "2", max_threads: 2, max_execution_time: 10 },
    });
  });
  afterAll(async () => {
    await client.close();
  });

  async function matchingRows(userId: string, aliases: string[], siteId = 1) {
    mocks.aliases = aliases.map(anonymousId => ({ anonymousId }));
    await deleteUser(request(userId, String(siteId)) as never, reply() as never);
    const deletion = heatmapDelete();
    const predicate = deletion.query.slice(deletion.query.indexOf(" WHERE ") + " WHERE ".length);
    const fixture = `WITH heatmap_events AS (SELECT * FROM values(
      'row_id String, site_id UInt32, user_id String, identified_user_id String',
      ('alice-on-shared', 1, 'dev-shared', 'alice'),
      ('anonymous-on-shared', 1, 'dev-shared', ''),
      ('bob-on-shared', 1, 'dev-shared', 'bob'),
      ('other-site-alice', 2, 'dev-shared', 'alice'),
      ('other-site-anonymous', 2, 'dev-shared', ''),
      ('unlinked-anonymous', 1, 'dev-unlinked', ''),
      ('alice-on-unlinked', 1, 'dev-unlinked', 'alice'),
      ('alice-device-id', 1, 'alice', ''),
      ('anonymous-on-other-linked', 1, 'dev-other', ''),
      ('bob-on-other-linked', 1, 'dev-other', 'bob'),
      ('high-site-alice', 70001, 'dev-shared', 'alice'),
      ('high-site-anonymous', 70001, 'dev-shared', ''),
      ('high-site-bob', 70001, 'dev-shared', 'bob'),
      ('wrapped-site-alice', 4465, 'dev-shared', 'alice'),
      ('wrapped-site-anonymous', 4465, 'dev-shared', '')
    ))`;
    const result = await client.query({
      query: `${fixture} SELECT row_id FROM heatmap_events WHERE ${predicate} ORDER BY row_id`,
      query_params: deletion.query_params,
      format: "JSONEachRow",
    });
    return (await result.json<{ row_id: string }>()).map(row => row.row_id);
  }

  it("removes identified and linked anonymous activity while preserving other users and sites", async () => {
    expect(await matchingRows("alice", ["dev-shared", "dev-other"])).toEqual([
      "alice-device-id",
      "alice-on-shared",
      "alice-on-unlinked",
      "anonymous-on-other-linked",
      "anonymous-on-shared",
    ]);
  });

  it("removes an anonymous fingerprint without erasing identified activity on the same device", async () => {
    expect(await matchingRows("dev-shared", [])).toEqual(["anonymous-on-shared"]);
  });

  it("erases a UInt32 site without wrapping into another site's matching user and device", async () => {
    expect(await matchingRows("alice", ["dev-shared"], 70001)).toEqual(["high-site-alice", "high-site-anonymous"]);
  });
});
