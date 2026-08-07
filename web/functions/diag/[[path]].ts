// 诊断报告的收集与查看。
//
//   POST /diag              上传一条（页面调用，无需身份）
//   GET  /diag?token=…      列出最近的报告（需要 DIAG_TOKEN）
//   GET  /diag/<id>?token=… 看某一条的正文
//   GET  /diag/stats?token=…  占用量与配额
//
// 为什么不在 /api/* 下：那个前缀整体转发给 tunnel 后面的内网后端
// （functions/api/[[path]].ts），诊断报告不该往那儿去，它属于紧邻页面的这个
// Function。放在 /diag 也就不受那条转发规则和 Cloudflare 侧任何 /api 改写的影响。
//
// ## 上传为什么不要身份
//
// 因为它必须能在"出问题的那台机器上"点得下去，而那台机器的人不一定有这个站的任何凭据。
// 代价是这是个公开可写的接口，所以三道闸都在这里：正文体积上限、按来源限流、以及总量
// 配额淘汰 —— 最坏情况下攻击者能做的是把库塞满，而塞满的结果只是最旧的报告被删掉，
// 不会产生费用，也不会影响页面本身。查看侧就必须有 token 了。

interface Env {
  /** D1 binding，见 wrangler.toml。 */
  adbstudio_diag?: D1Database;
  /** 查看报告用的口令。没配 = 查看接口直接关闭（上传照常）。 */
  DIAG_TOKEN?: string;
  /** ip_hash 的盐。没配就用一个固定值 —— 哈希仍然不可逆，只是跨部署可比。 */
  DIAG_SALT?: string;
  /**
   * 配额覆盖，用于测试。生产上不设 —— 默认值就是想要的值。
   * 淘汰这条路径不可能用真实数据量在测试里走到（要先写满 200MB），所以必须能调小。
   */
  DIAG_BUDGET_BYTES?: string;
  DIAG_MAX_ROWS?: string;
}

/** 单条正文上限。diag.ts 自己会先裁到 96KB，这里是最后一道。 */
const MAX_BODY = 192 * 1024;
/**
 * 库的总字节预算。D1 免费额度是 5GB，取其 4% —— 报告是给人看的，不是归档；
 * 留出的余量也让"到底还剩多少"永远不必去猜。
 */
const BUDGET_BYTES = 200 * 1024 * 1024;
/** 行数上限，防止有人用大量极小的报告把行数刷爆（读配额按行算）。 */
const MAX_ROWS = 20000;
/** 同一来源每分钟、每天的上限。 */
const PER_MINUTE = 6;
const PER_DAY = 200;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "cache-control": "no-store" } });

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * 短 ID：时间前缀 + 随机后缀。
 *
 * 前缀是 base36 的时间戳，所以 ID 本身按字典序就是时间序 —— 一眼能看出哪条更新，
 * 排查时报一句 ID 也能大致定位时间。
 */
function newId(): string {
  const rand = [...crypto.getRandomValues(new Uint8Array(5))]
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  return `${Date.now().toString(36)}-${rand}`;
}

/** 报告的一句话摘要：列表里用它分类，不用打开正文。 */
function summarize(report: Record<string, unknown>): string {
  const events = Array.isArray(report.events) ? (report.events as { kind: string; msg: string }[]) : [];
  // 最后一次失败最能说明问题；没有失败就用最后一条事件。
  const failure = [...events]
    .reverse()
    .find((e) => /fail|error|busy|rejection/i.test(`${e.kind} ${e.msg}`));
  const pick = failure ?? events[events.length - 1];
  return pick ? `${pick.kind}: ${pick.msg}`.slice(0, 160) : "(no events)";
}

function serialsOf(report: Record<string, unknown>): string {
  const out = new Set<string>();
  const usb = Array.isArray(report.usb) ? (report.usb as { serial?: string }[]) : [];
  for (const d of usb) if (d.serial) out.add(d.serial);
  const state = (report.state ?? {}) as { devices?: { serial?: string }[] };
  for (const d of state.devices ?? []) if (d.serial) out.add(d.serial);
  return [...out].join(",");
}

/**
 * 配额淘汰：超预算就按时间从最旧删起。
 *
 * 每次上传后跑，而不是定时任务 —— Pages Function 没有 cron，而"写入的时候顺手收拾"
 * 天然把清理频率和增长速度绑在一起：不写就不需要清。
 */
async function evict(
  db: D1Database,
  budgetBytes = BUDGET_BYTES,
  maxRows = MAX_ROWS,
): Promise<{ deleted: number; bytes: number; rows: number }> {
  // 过期的限流桶：一天以前的桶对任何判断都没用了，留着只是白占地方。
  await db
    .prepare("DELETE FROM rate_limit WHERE bucket < ?")
    .bind(Math.floor(Date.now() / 60_000) - 1441)
    .run();

  const stats = await db
    .prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(bytes), 0) AS bytes FROM reports")
    .first<{ rows: number; bytes: number }>();
  let rows = stats?.rows ?? 0;
  let bytes = stats?.bytes ?? 0;
  let deleted = 0;

  // 一次最多删 200 条：单次请求的时间和写配额都有限，剩下的下次上传接着收拾。
  while ((bytes > budgetBytes || rows > maxRows) && deleted < 200) {
    const victim = await db
      .prepare("SELECT id, bytes FROM reports ORDER BY created_at ASC LIMIT 1")
      .first<{ id: string; bytes: number }>();
    if (!victim) break;
    await db.prepare("DELETE FROM reports WHERE id = ?").bind(victim.id).run();
    bytes -= victim.bytes;
    rows -= 1;
    deleted += 1;
  }
  return { deleted, bytes, rows };
}

/**
 * 限流，计数存在独立的 rate_limit 表里。
 *
 * 一开始是数 reports 里同来源最近一分钟的行数 —— 错的：配额淘汰会删掉最旧的行，
 * 于是洪水攻击把表压小之后计数永远到不了阈值，限流在最需要它的时候失灵。实测把
 * MAX_ROWS 调成 3 连发 8 条，一条都没拦住。计数必须独立于会被删的数据。
 *
 * 先记后判：即使被拒，这一次尝试也计入，否则超限之后的持续敲门是"免费"的。
 */
async function throttled(db: D1Database, ipHash: string): Promise<string | null> {
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  await db
    .prepare(
      `INSERT INTO rate_limit (ip_hash, bucket, n) VALUES (?, ?, 1)
       ON CONFLICT (ip_hash, bucket) DO UPDATE SET n = n + 1`,
    )
    .bind(ipHash, bucket)
    .run();

  const minute = await db
    .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM rate_limit WHERE ip_hash = ? AND bucket = ?")
    .bind(ipHash, bucket)
    .first<{ n: number }>();
  if ((minute?.n ?? 0) > PER_MINUTE) return "太频繁了，等一分钟再试";

  const day = await db
    .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM rate_limit WHERE ip_hash = ? AND bucket > ?")
    .bind(ipHash, bucket - 1440)
    .first<{ n: number }>();
  if ((day?.n ?? 0) > PER_DAY) return "今天上传的次数已达上限";
  return null;
}

function authorized(request: Request, env: Env): boolean {
  if (!env.DIAG_TOKEN) return false;
  const url = new URL(request.url);
  const given = request.headers.get("x-diag-token") ?? url.searchParams.get("token") ?? "";
  // 长度不同直接不等；等长时逐字符异或，避免用比较时间泄露前缀。
  if (given.length !== env.DIAG_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.DIAG_TOKEN.charCodeAt(i);
  return diff === 0;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const db = env.adbstudio_diag;
  if (!db) return text("诊断存储未配置（缺 D1 绑定）", 503);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return text("报告太大", 413);

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return text("不是合法 JSON", 400);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await sha256(`${env.DIAG_SALT ?? "adbstudio"}:${ip}`);
  const limit = await throttled(db, ipHash);
  if (limit) return text(limit, 429);

  const id = newId();
  const env_ = (report.env ?? {}) as { ua?: string; platform?: string };
  await db
    .prepare(
      `INSERT INTO reports (id, created_at, version, note, ua, platform, summary, serials, ip_hash, bytes, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      // 服务端时间：客户端时钟错乱过（实测有机器差几小时），而列表和淘汰都依赖它。
      Date.now(),
      String(report.version ?? ""),
      String(report.note ?? "").slice(0, 500),
      String(env_.ua ?? "").slice(0, 400),
      String(env_.platform ?? ""),
      summarize(report),
      serialsOf(report),
      ipHash,
      raw.length,
      raw,
    )
    .run();

  const after = await evict(
    db,
    Number(env.DIAG_BUDGET_BYTES ?? BUDGET_BYTES),
    Number(env.DIAG_MAX_ROWS ?? MAX_ROWS),
  );
  return json({ id, stored: raw.length, evicted: after.deleted });
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  const db = env.adbstudio_diag;
  if (!db) return text("诊断存储未配置（缺 D1 绑定）", 503);
  if (!authorized(request, env)) return text("需要 token", 401);

  const parts = (params.path as string[] | undefined) ?? [];
  const url = new URL(request.url);

  if (parts[0] === "stats") {
    const stats = await db
      .prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(bytes),0) AS bytes, MIN(created_at) AS oldest FROM reports")
      .first<{ rows: number; bytes: number; oldest: number | null }>();
    return json({
      ...stats,
      budgetBytes: Number(env.DIAG_BUDGET_BYTES ?? BUDGET_BYTES),
      maxRows: Number(env.DIAG_MAX_ROWS ?? MAX_ROWS),
      usedPercent: stats
        ? Math.round((stats.bytes / Number(env.DIAG_BUDGET_BYTES ?? BUDGET_BYTES)) * 1000) / 10
        : 0,
    });
  }

  if (parts.length > 0) {
    const row = await db
      .prepare("SELECT id, created_at, version, note, ua, platform, summary, serials, bytes, payload FROM reports WHERE id = ?")
      .bind(parts[0])
      .first<Record<string, unknown>>();
    if (!row) return text("没有这条报告", 404);
    return json({ ...row, payload: JSON.parse(String(row.payload)) });
  }

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  const serial = url.searchParams.get("serial");
  const listing = serial
    ? await db
        .prepare(
          `SELECT id, created_at, version, note, ua, platform, summary, serials, bytes FROM reports
           WHERE serials LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(`%${serial}%`, limit)
        .all()
    : await db
        .prepare(
          `SELECT id, created_at, version, note, ua, platform, summary, serials, bytes FROM reports
           ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
  return json({ reports: listing.results });
};
