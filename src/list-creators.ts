import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CountRow = { n: number };

// Pontuação, alcance e entregas calculados de uma vez no banco, para o número
// de queries não depender da quantidade de criadores.
const SCORED_CREATORS = `
  WITH
  -- niche_score: pares (nicho da campanha, nicho do criador) iguais, como o loop original.
  -- Nichos são strings; o filtro por tipo evita que o SQLite case true com 1, o que o === do JS não faz.
  scored AS (
    SELECT c.id, c.name,
      (SELECT COUNT(*)
         FROM json_each(c.niches_json) AS mine
         JOIN json_each(?) AS wanted ON mine.value = wanted.value AND mine.type = 'text' AND wanted.type = 'text') AS niche_score
    FROM creators c
  ),
  -- Métrica mais recente de cada conta: maior captured_at, empate por id decrescente.
  latest AS (
    SELECT account_id, views,
      ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS rank
    FROM metrics
  ),
  -- latest_reach: soma das views da métrica mais recente de cada conta do criador.
  reach AS (
    SELECT a.creator_id, SUM(l.views) AS latest_reach
    FROM social_accounts a
    JOIN latest l ON l.account_id = a.id AND l.rank = 1
    GROUP BY a.creator_id
  ),
  -- deliveries_90d: entregas com delivered_at >= 90 dias antes de AS_OF (inclusivo).
  deliveries_recent AS (
    SELECT creator_id, COUNT(*) AS n
    FROM deliveries
    WHERE delivered_at >= ?
    GROUP BY creator_id
  )
  SELECT s.id, s.name, s.niche_score,
    COALESCE(r.latest_reach, 0) AS latest_reach,
    COALESCE(d.n, 0) AS deliveries_90d
  FROM scored s
  LEFT JOIN reach r ON r.creator_id = s.id
  LEFT JOIN deliveries_recent d ON d.creator_id = s.id
  WHERE s.niche_score > 0
  -- Ordem do README: niche_score desc, latest_reach desc, id asc.
  ORDER BY s.niche_score DESC, latest_reach DESC, s.id ASC
  LIMIT ? OFFSET ?
`;

const COUNT_MATCHING = `
  SELECT COUNT(*) AS n
  FROM creators c
  WHERE EXISTS (
    SELECT 1
    FROM json_each(c.niches_json) AS mine
    JOIN json_each(?) AS wanted ON mine.value = wanted.value AND mine.type = 'text' AND wanted.type = 'text'
  )
`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const creators = await all<CreatorMatch>(
    db,
    SCORED_CREATORS,
    campaign.niches_json,
    deliveriesSince(),
    input.limit,
    input.offset,
  );
  const total = await get<CountRow>(db, COUNT_MATCHING, campaign.niches_json);

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: creators.map((creator) => ({
      id: creator.id,
      name: creator.name,
      niche_score: Number(creator.niche_score),
      latest_reach: Number(creator.latest_reach),
      deliveries_90d: Number(creator.deliveries_90d),
    })),
  };
}
