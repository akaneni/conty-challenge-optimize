import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deliveriesSince } from "../src/clock.ts";
import { openDatabase } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";

// Compara a listagem atual com a original (N+1) em volumes maiores que o do seed, com empates
// de score, alcance e captured_at, e com páginas além do fim. A cópia abaixo é só referência.
type Row = Record<string, unknown>;

// Implementação original (N+1), mantida aqui só como referência de comportamento.
function referenceList(db: DatabaseSync, campaignId: string, limit: number, offset: number) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as Row | undefined;
  if (!campaign) return null;
  const campaignNiches = JSON.parse(campaign.niches_json as string) as string[];
  const since = deliveriesSince();
  const scored = [];
  for (const creator of db.prepare("SELECT * FROM creators").all() as Row[]) {
    const creatorNiches = JSON.parse(creator.niches_json as string) as string[];
    let niche_score = 0;
    for (const a of campaignNiches) for (const b of creatorNiches) if (a === b) niche_score += 1;
    if (niche_score === 0) continue;
    let latest_reach = 0;
    for (const account of db.prepare("SELECT * FROM social_accounts WHERE creator_id = ?").all(creator.id as string) as Row[]) {
      const metric = db
        .prepare("SELECT * FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
        .get(account.id as string) as Row | undefined;
      if (metric) latest_reach += metric.views as number;
    }
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?")
      .get(creator.id as string, since) as { n: number };
    scored.push({ id: creator.id as string, name: creator.name as string, niche_score, latest_reach, deliveries_90d: Number(n.n) });
  }
  scored.sort(
    (l, r) =>
      r.niche_score - l.niche_score || r.latest_reach - l.latest_reach || (l.id < r.id ? -1 : l.id > r.id ? 1 : 0),
  );
  return { campaign_id: campaignId, total: scored.length, creators: scored.slice(offset, offset + limit) };
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Poucos valores possíveis de propósito: gera muito empate de score, alcance e captured_at.
function populate(creators: number, seed: number): DatabaseSync {
  const rand = lcg(seed);
  const niches = ["beleza", "moda", "tech", "games"];
  const instants = ["2026-05-30T00:00:00.000Z", "2026-05-29T00:00:00.000Z", "2026-05-28T00:00:00.000Z"];
  const edges = ["2026-03-03T12:00:00.000Z", "2026-03-03T11:59:59.999Z", "2026-05-01T00:00:00.000Z"];
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO campaigns VALUES ('cmp_x', 'X', ?)").run(JSON.stringify(["beleza", "moda", "beleza"]));
  db.exec("BEGIN");
  for (let i = 0; i < creators; i += 1) {
    const id = `crt_${String(i).padStart(5, "0")}`;
    const mine = niches.filter(() => rand() < 0.5);
    if (rand() < 0.2) mine.push("beleza");
    db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')").run(id, `C${i}`, JSON.stringify(mine));
    for (let a = 0; a < Math.floor(rand() * 3); a += 1) {
      const acc = `acc_${id}_${a}`;
      db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')").run(acc, id);
      for (let m = 0; m < Math.floor(rand() * 4); m += 1) {
        db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')").run(
          `met_${acc}_${m}`,
          acc,
          Math.floor(rand() * 4) * 100,
          instants[Math.floor(rand() * instants.length)]!,
        );
      }
    }
    for (let d = 0; d < Math.floor(rand() * 3); d += 1) {
      db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)").run(`del_${id}_${d}`, id, edges[Math.floor(rand() * edges.length)]!);
    }
  }
  db.exec("COMMIT");
  return db;
}

describe("listagem igual à implementação original", () => {
  it.each([
    [150, 1],
    [900, 2],
    [2500, 3],
  ])("com %i criadores, empates e várias páginas", async (creators, seed) => {
    const db = populate(creators, seed);
    for (const [limit, offset] of [[20, 0], [20, 20], [50, 40], [7, 3], [20, creators], [20, creators * 10], [20, Number.MAX_SAFE_INTEGER]] as const) {
      expect(await listCreators(db, { campaignId: "cmp_x", limit, offset })).toEqual(
        referenceList(db, "cmp_x", limit, offset),
      );
    }
  });

  it("não casa nicho que não é texto (true não casa com 1)", async () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_t', 'Tipos', '[1, "beleza"]');
      INSERT INTO creators VALUES ('crt_a', 'Booleano', '[true]', ''), ('crt_b', 'Texto', '["beleza"]', '');
    `);
    const page = await listCreators(db, { campaignId: "cmp_t", limit: 20, offset: 0 });
    expect(page?.total).toBe(1);
    expect(page?.creators.map((creator) => creator.id)).toEqual(["crt_b"]);
    expect(page).toEqual(referenceList(db, "cmp_t", 20, 0));
  });

  it("devolve null para campanha inexistente", async () => {
    expect(await listCreators(populate(5, 9), { campaignId: "nope", limit: 20, offset: 0 })).toBeNull();
  });
});
