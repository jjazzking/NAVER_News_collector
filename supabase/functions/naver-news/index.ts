// 네이버 뉴스 검색 정리 툴 — Supabase Edge Function
//
// GitHub Pages 화면(docs/)이 호출하는 백엔드.
// 네이버 API 키는 Supabase secrets(NEWS_COLLECTOR_NAVER_CLIENT_ID / NEWS_COLLECTOR_NAVER_CLIENT_SECRET)에만 저장되어 화면에 노출되지 않는다.
// Supabase secrets 는 프로젝트 전체가 공유하므로, 다른 함수와 겹치지 않게 NEWS_COLLECTOR_ 접두사를 붙인다.
// 키는 NAVER Cloud 콘솔의 NAVER API HUB 에서 발급받은 Client ID / Secret.
//
//   POST { action: "search", keyword, start_date, end_date, max_count }
//     → { count, articles: [{ title, date, source, body, link, originallink }], warning }
//   POST { action: "bodies", urls: string[] }   (최대 BODY_BATCH_MAX 개)
//     → { results: [{ url, body, source }] }
//
// 본문 수집은 요청 1회의 실행 시간 제한 때문에 화면에서 여러 번 나눠 호출한다.
import { parseHTML } from "npm:linkedom@0.18.5";

// NAVER API HUB 뉴스 검색 API
const NAVER_NEWS_API = "https://naverapihub.apigw.ntruss.com/search/v1/news";
const API_MAX_START = 1000; // 네이버 API는 start <= 1000 까지만 허용
const API_DISPLAY = 100; // 한 페이지 최대 100건
const BODY_BATCH_MAX = 20;
const BODY_TIMEOUT_MS = 8000;
const BODY_MAX_BYTES = 5 * 1024 * 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// --------------------------------------------------------------------------- //
// CORS
// --------------------------------------------------------------------------- //
// NEWS_COLLECTOR_ALLOWED_ORIGINS(쉼표 구분)를 설정하면 해당 사이트에서만 브라우저 호출 허용. 비워두면 모두 허용.
const ALLOWED_ORIGINS = (Deno.env.get("NEWS_COLLECTOR_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  let allow = "*";
  if (ALLOWED_ORIGINS.length) {
    allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// --------------------------------------------------------------------------- //
// 유틸
// --------------------------------------------------------------------------- //
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** API가 주는 제목/요약의 <b> 태그와 HTML 엔티티를 제거한다. */
function cleanHtml(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** RFC1123 형식(pubDate)을 KST 기준 { day: "YYYY-MM-DD", label: "YYYY-MM-DD HH:MM" } 로 변환. */
function parsePubDate(pub: string): { day: string; label: string } | null {
  const t = Date.parse(pub);
  if (Number.isNaN(t)) return null;
  const iso = new Date(t + 9 * 3600 * 1000).toISOString();
  return { day: iso.slice(0, 10), label: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------- //
// 검색
// --------------------------------------------------------------------------- //
interface Article {
  title: string;
  date: string;
  source: string;
  body: string;
  link: string;
  originallink: string;
}

async function callNaver(params: URLSearchParams) {
  const id = Deno.env.get("NEWS_COLLECTOR_NAVER_CLIENT_ID");
  const secret = Deno.env.get("NEWS_COLLECTOR_NAVER_CLIENT_SECRET");
  if (!id || !secret) {
    throw new HttpError(
      500,
      "서버에 NEWS_COLLECTOR_NAVER_CLIENT_ID / NEWS_COLLECTOR_NAVER_CLIENT_SECRET 이 설정되지 않았습니다. (supabase secrets set)",
    );
  }
  const resp = await fetch(`${NAVER_NEWS_API}?${params}`, {
    headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret },
  });
  if (resp.ok) return await resp.json();

  // 에러 형식: 검색 API { errorCode, errorMessage } / API 게이트웨이 { error: { errorCode, message, details } }
  const body = await resp.json().catch(() => ({}));
  const err = body.error ?? body;
  const detail = [resp.status, err.errorCode ?? err.code, err.errorMessage ?? err.message, err.details]
    .filter(Boolean).join(" ");
  // API 게이트웨이는 "키는 맞지만 이 API 가 Application 에 활성화되지 않음"도 401 로 준다.
  const notEnabled =
    /활성화|권한|not.*(enabled|subscribed)|permission/i.test(`${err.message ?? ""} ${err.details ?? ""}`) ||
    ["210", "401"].includes(String(err.errorCode ?? ""));
  if (resp.status === 403 || (resp.status === 401 && notEnabled)) {
    throw new HttpError(
      403,
      '네이버 API 권한 없음: NAVER API HUB → Application 수정에서 "뉴스" API 를 체크하고 저장했는지, ' +
        `Subscription 메뉴에서 검색 API 를 구독했는지 확인하세요. (${detail})`,
    );
  }
  if (resp.status === 401) {
    throw new HttpError(401, `네이버 인증 실패: NAVER API HUB 의 Client ID / Secret 을 확인하세요. (${detail})`);
  }
  if (resp.status === 429) {
    throw new HttpError(429, `네이버 API 일일 호출 한도를 초과했습니다. (${detail})`);
  }
  throw new HttpError(502, `네이버 API 요청 실패: ${detail}`);
}
/**
 * 한 가지 정렬로 최대 1,000건을 훑어 기간 안의 기사만 모은다.
 *   date(최신순): 시작일보다 오래된 기사가 나오면 이후도 전부 과거라 바로 멈춘다.
 *   sim(정확도순): 날짜 순서가 섞여 있어 끝까지 훑으며 기간 밖 기사만 거른다.
 */
async function fetchSorted(
  keyword: string,
  sort: "date" | "sim",
  startDate: string,
  endDate: string,
  limit: number,
) {
  const articles: Article[] = [];
  let reachedStart = false; // 최신순이 시작일까지 닿았는지
  let exhausted = false; // 검색 결과를 끝까지 다 봤는지
  let oldestSeen = ""; // 훑은 기사 중 가장 오래된 날짜 (최신순에서 어디까지 닿았는지)

  for (let start = 1; start <= API_MAX_START; start += API_DISPLAY) {
    const data = await callNaver(
      new URLSearchParams({ query: keyword, display: String(API_DISPLAY), start: String(start), sort }),
    );
    const items = data.items ?? [];
    if (!items.length) {
      exhausted = true;
      break;
    }

    for (const it of items) {
      const pub = parsePubDate(it.pubDate ?? "");
      if (!pub) continue;
      if (!oldestSeen || pub.day < oldestSeen) oldestSeen = pub.day;
      if (pub.day < startDate) {
        if (sort === "date") {
          reachedStart = true;
          break;
        }
        continue;
      }
      if (pub.day > endDate) continue;
      articles.push({
        title: cleanHtml(it.title),
        date: pub.label,
        source: domainOf(it.originallink || it.link || ""),
        body: cleanHtml(it.description), // 우선 요약으로 채움
        link: it.link || it.originallink || "",
        originallink: it.originallink || "",
      });
      if (articles.length >= limit) break;
    }

    if (reachedStart || articles.length >= limit) break;
    if (items.length < API_DISPLAY) {
      exhausted = true;
      break;
    }
  }
  return { articles, reachedStart, exhausted, oldestSeen };
}

/** 시간순으로 정렬된 목록에서 n건을 고르게 뽑는다 (특정 기간에 몰리지 않도록). */
function sampleEvenly<T>(sorted: T[], n: number): T[] {
  if (sorted.length <= n) return sorted;
  const step = sorted.length / n;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)]);
}

/**
 * 네이버 API 는 검색어당 1,000건까지만 주고 기간 지정이 없어서, 최신순만으로는 최근 기사에서 끝난다.
 * 최신순 + 정확도순을 함께 가져와 합치면 정확도순이 더 오래된 기사를 채워 준다.
 */
async function searchNews(keyword: string, startDate: string, endDate: string, maxCount: number) {
  const [byDate, bySim] = await Promise.all([
    fetchSorted(keyword, "date", startDate, endDate, maxCount),
    fetchSorted(keyword, "sim", startDate, endDate, maxCount),
  ]);

  const merged = new Map<string, Article>();
  for (const a of [...byDate.articles, ...bySim.articles]) {
    const key = a.originallink || a.link;
    if (!merged.has(key)) merged.set(key, a);
  }
  const all = [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
  const articles = sampleEvenly(all, maxCount);

  const warnings: string[] = [];
  const dateHitLimit = !byDate.reachedStart && !byDate.exhausted && byDate.articles.length < maxCount;
  if (dateHitLimit) {
    warnings.push(
      `최신순 검색은 네이버 API 한도(최신 1,000건)로 ${byDate.oldestSeen}까지만 닿았습니다. ` +
        "그 이전 기간은 정확도순 검색 결과(관련도 높은 기사 위주)로만 채워져 빠진 기사가 있을 수 있습니다.",
    );
  }
  if (all.length > articles.length) {
    warnings.push(
      `기간 내 기사 ${all.length}건 중 최대 수집 건수(${maxCount}건)에 맞춰 기간 전체에서 고르게 ${articles.length}건을 추렸습니다.`,
    );
  }
  return { articles, warning: warnings.length ? warnings.join(" ") : null };
}
// --------------------------------------------------------------------------- //
// 본문 / 출처 추출 (기사 링크에 실제 접속)
// --------------------------------------------------------------------------- //
const BODY_SELECTORS = [
  "#dic_area", // 네이버 뉴스 (신형)
  "#newsct_article", // 네이버 뉴스
  ".newsct_article",
  "#articeBody", // 네이버 연예/스포츠
  "#articleBodyContents", // 네이버 뉴스 (구형)
  "article", // 일반 언론사 폴백
];

/** 공개 웹 주소만 허용 (내부망/IP 직접 접근 차단). */
function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false; // IPv4/IPv6 리터럴
  return host.includes(".");
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    signal: AbortSignal.timeout(BODY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.length > BODY_MAX_BYTES) buf = buf.slice(0, BODY_MAX_BYTES);

  // 인코딩 판별: Content-Type → <meta charset> → utf-8 (EUC-KR 언론사 대응)
  let charset = /charset=["']?([\w-]+)/i.exec(resp.headers.get("content-type") ?? "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

/** BeautifulSoup get_text(separator="\n", strip=True) 와 같은 방식으로 텍스트를 모은다. */
// deno-lint-ignore no-explicit-any
function textLines(node: any, out: string[] = []): string[] {
  for (const child of node.childNodes ?? []) {
    if (child.nodeType === 3) {
      const t = (child.textContent ?? "").trim();
      if (t) out.push(t);
    } else if (child.nodeType === 1) {
      const tag = (child.tagName ?? "").toLowerCase();
      if (tag !== "script" && tag !== "style" && tag !== "noscript") textLines(child, out);
    }
  }
  return out;
}

async function extractBodyAndSource(url: string) {
  const fallbackSource = domainOf(url);
  if (!isFetchableUrl(url)) return { url, body: "", source: fallbackSource };

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch {
    return { url, body: "", source: fallbackSource };
  }
  // linkedom 타입은 브라우저 DOM 타입을 전제로 해서 Deno 에서는 any 로 다룬다.
  // deno-lint-ignore no-explicit-any
  const { document } = parseHTML(html) as any;

  // 출처(언론사) 추출
  let source = fallbackSource;
  const logo = document.querySelector(
    ".media_end_head_top_logo img, .press_logo img, a.media_end_head_top_logo_img img",
  );
  const alt = logo?.getAttribute("alt")?.trim();
  if (alt) {
    source = alt;
  } else {
    const site = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
    if (site && site !== "네이버 뉴스" && site !== "NAVER") source = site;
  }

  // 본문 추출
  let body = "";
  for (const sel of BODY_SELECTORS) {
    const node = document.querySelector(sel);
    if (node) {
      body = textLines(node).join("\n");
      if (body.length > 50) break;
    }
  }
  if (!body) {
    body = document.querySelector('meta[property="og:description"]')?.getAttribute("content")?.trim() ?? "";
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  return { url, body, source };
}

// --------------------------------------------------------------------------- //
// 라우트
// --------------------------------------------------------------------------- //
async function handle(data: Record<string, unknown>) {
  if (data.action === "search") {
    const keyword = String(data.keyword ?? "").trim();
    const startDate = String(data.start_date ?? "");
    const endDate = String(data.end_date ?? "");
    if (!keyword) throw new HttpError(400, "검색 키워드를 입력하세요.");
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
      throw new HttpError(400, "기간(시작일/종료일)을 올바르게 입력하세요.");
    }
    if (startDate > endDate) throw new HttpError(400, "시작일이 종료일보다 늦습니다.");
    const n = parseInt(String(data.max_count ?? 200), 10);
    const maxCount = Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 200;

    const { articles, warning } = await searchNews(keyword, startDate, endDate, maxCount);
    return { count: articles.length, articles, warning };
  }

  if (data.action === "bodies") {
    const urls = Array.isArray(data.urls) ? data.urls.map(String) : [];
    if (!urls.length) throw new HttpError(400, "urls 가 비어 있습니다.");
    if (urls.length > BODY_BATCH_MAX) throw new HttpError(400, `urls 는 한 번에 최대 ${BODY_BATCH_MAX}개입니다.`);
    return { results: await Promise.all(urls.map(extractBodyAndSource)) };
  }

  throw new HttpError(400, 'action 은 "search" 또는 "bodies" 여야 합니다.');
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });

  if (req.method !== "POST") return json({ error: "POST 요청만 허용됩니다." }, 405);

  try {
    const data = await req.json().catch(() => {
      throw new HttpError(400, "요청 본문이 올바른 JSON 이 아닙니다.");
    });
    return json(await handle(data ?? {}));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: `서버 오류: ${e instanceof Error ? e.message : e}` }, 500);
  }
});
