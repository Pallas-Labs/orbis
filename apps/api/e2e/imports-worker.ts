import { hashToken } from "../../server/src/identity.js";
import { Group as ProductionGroup } from "../src/group.js";

export { default } from "../src/index.js";

const ALARM_RUNS = "e2e-alarm-runs";

export class Group extends ProductionGroup {
  override async alarm(): Promise<void> {
    const runs = (await this.ctx.storage.get<number[]>(ALARM_RUNS)) ?? [];
    await this.ctx.storage.put(ALARM_RUNS, [...runs, Date.now()]);
    await super.alarm();
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__seed-imports") {
      await super.fetch(new Request("http://localhost/health"));
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO people (id, username, removed, social, auto_download, filters) VALUES ('importer', 'importer', 0, 0, 0, '[]')"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO api_keys (id, digest, label, scope, person_id, added_at, last_used_at) VALUES ('importer-key', ?, 'importer', 'daily', 'importer', ?, NULL)",
        hashToken("importer-token"),
        new Date().toISOString()
      );
      return new Response("seeded");
    }
    if (pathname === "/__imports") {
      return Response.json({
        alarm: await this.ctx.storage.getAlarm(),
        alarmRuns: (await this.ctx.storage.get<number[]>(ALARM_RUNS)) ?? [],
        imports: this.ctx.storage.sql
          .exec(
            "SELECT id, state, page_token, processed, total, added, unavailable, failure, updated_at FROM playlist_imports"
          )
          .toArray(),
        members: this.ctx.storage.sql
          .exec(
            "SELECT s.url AS url FROM playlist_sets m JOIN sets s ON s.id = m.set_id ORDER BY m.position"
          )
          .toArray()
          .map((row) => row.url),
        sets: this.ctx.storage.sql
          .exec("SELECT COUNT(*) AS count FROM sets")
          .one().count,
      });
    }
    return super.fetch(request);
  }
}
