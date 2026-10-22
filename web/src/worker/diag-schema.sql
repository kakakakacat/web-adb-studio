-- 诊断报告表（D1）。建库/建表：
--
--   npx wrangler d1 create adbstudio-diag
--   npx wrangler d1 execute adbstudio-diag --remote --file=functions/diag-schema.sql
--
-- 一条报告就是一行，正文是 diag.ts 的 JSON 原样。选 D1 而不是 R2：报告只有几 KB，
-- 而真正要做的事是"按时间列出来、按机器筛、看某一条"—— 那是 SQL 的活，R2 还得自己
-- 维护一份索引。配额淘汰也顺带变成一条 DELETE。

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,          -- epoch ms，服务端时钟（客户端时钟可能是错的）
  version     TEXT,                      -- 产生这条报告的 bundle 文件名 = 哪一次部署
  note        TEXT,                      -- 用户填的一句话
  ua          TEXT,
  platform    TEXT,
  -- 首要症状，用来在列表里一眼分类，不用打开正文
  summary     TEXT,
  serials     TEXT,                      -- 逗号分隔，用来按机器/设备筛
  -- 客户端 IP 的 SHA-256（加盐）。存哈希而不是 IP：限流只需要"是不是同一个来源"，
  -- 不需要知道是谁。
  ip_hash     TEXT,
  bytes       INTEGER NOT NULL,
  payload     TEXT NOT NULL
);

-- 列表和淘汰都按时间走。
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);
-- 限流查询：某个来源最近一分钟写了几条。
CREATE INDEX IF NOT EXISTS idx_reports_ip ON reports (ip_hash, created_at DESC);

-- 限流计数。**必须和 reports 分开**：限流原本是数 reports 里同来源最近一分钟的行数，
-- 但配额淘汰会把最旧的行删掉 —— 洪水攻击下表被压得很小，计数永远到不了阈值，限流
-- 恰好在最需要它的时候失灵（实测：MAX_ROWS=3 时连发 8 条，一条都没被拦）。
-- 这张表只存计数、不存正文，永远不参与淘汰，只按时间清理过期的桶。
CREATE TABLE IF NOT EXISTS rate_limit (
  ip_hash TEXT    NOT NULL,
  bucket  INTEGER NOT NULL,             -- floor(epoch_ms / 60000)，一分钟一个桶
  n       INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket)
);

CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_limit (bucket);
