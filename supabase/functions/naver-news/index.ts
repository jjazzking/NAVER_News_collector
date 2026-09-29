// 네이버 뉴스 검색 정리 툴 — Supabase Edge Function
//
// GitHub Pages 화면(docs/)이 호출하는 백엔드.
// 네이버 API 키는 Supabase secrets(NEWS_COLLECTOR_NAVER_CLIENT_ID / NEWS_COLLECTOR_NAVER_CLIENT_SECRET)에만 저장되어 화면에 노출되지 않는다.
// Supabase secrets 는 프로젝트 전체가 공유하므로, 다른 함수와 겹치지 않게 NEWS_COLLECTOR_ 접두사를 붙인다.
// 기본은 NAVER API HUB 키. 개발자센터 키를 쓰면 NEWS_COLLECTOR_NAVER_API_PROVIDER=developers 도 설정한다.
//
//   POST { action: "search", keyword, start_date, end_date, max_count }
//     → { count, articles: [{ title, date, source, body, link, originallink }], warning }
//   POST { action: "bodies", urls: string[] }   (최대 BODY_BATCH_MAX 개)
//     → { results: [{ url, body, source }] }
//
// 본문 수집은 요청 1회의 실행 시간 제한 때문에 화면에서 여러 번 나눠 호출한다.
import { parseHTML } from "npm:linkedom@0.18.5";

// 네이버 검색 API 는 발급처가 두 곳이다. NEWS_COLLECTOR_NAVER_API_PROVIDER 로 선택 (기본: hub)
//   hub        : NAVER Cloud 콘솔의 NAVER API HUB
//   developers : 네이버 개발자센터(developers.naver.com)
const NAVER_API_PROVIDERS = {
  hub: {
    url: "https://naverapihub.apigw.ntruss.com/search/v1/news",
    idHeader: "X-NCP-APIGW-API-KEY-ID",
    secretHeader: "X-NCP-APIGW-API-KEY",
    permissionHint: 'NAVER API HUB → Application 수정에서 "뉴스" API 를 체크하고 저장했는지, ' +
      "Subscription 메뉴에서 검색 API 를 구독했는지 확인하세요.",
  },
  developers: {
    url: "https://openapi.naver.com/v1/search/news.json",
    idHeader: "X-Naver-Client-Id",
    secretHeader: "X-Naver-Client-Secret",
    permissionHint: '개발자센터 애플리케이션에 "검색" API 를 추가하세요.',
  },
};
const PROVIDER_NAME = Deno.env.get("NEWS_COLLECTOR_NAVER_API_PROVIDER") === "developers" ? "developers" : "hub";
const NAVER_API = NAVER_API_PROVIDERS[PROVIDER_NAME];
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
  const resp = await fetch(`${NAVER_API.url}?${params}`, {
    headers: { [NAVER_API.idHeader]: id, [NAVER_API.secretHeader]: secret },
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
    throw new HttpError(403, `네이버 API 권한 없음: ${NAVER_API.permissionHint} (${detail})`);
  }
  if (resp.status === 401) {
    const other = PROVIDER_NAME === "hub" ? "developers" : "hub";
    throw new HttpError(
      401,
      `네이버 인증 실패: Client ID / Secret 을 확인하세요. ` +
        `키 발급처가 다르면 NEWS_COLLECTOR_NAVER_API_PROVIDER=${other} 로 설정하세요. (현재: ${PROVIDER_NAME}, ${detail})`,
    );
  }
  if (resp.status === 429) {
    throw new HttpError(429, `네이버 API 일일 호출 한도를 초과했습니다. (${detail})`);
  }
  throw new HttpError(502, `네이버 API 요청 실패: ${detail}`);
}

async function searchNews(keyword: string, startDate: string, endDate: string, maxCount: number) {
  const collected: Article[] = [];
  let reachedOlderThanRange = false;
  let hitApiLimit = false;

  for (let start = 1; start <= API_MAX_START; start += API_DISPLAY) {
    const data = await callNaver(
      new URLSearchParams({
        query: keyword,
        display: String(API_DISPLAY),
        start: String(start),
        sort: "date", // 최신순 (기간 필터를 위해 필수)
      }),
    );
    const items = data.items ?? [];
    if (!items.length) break;

    for (const it of items) {
      const pub = parsePubDate(it.pubDate ?? "");
      if (!pub) continue;
      // 최신순이므로 시작일보다 과거면 이후 항목도 전부 과거 → 종료
      if (pub.day < startDate) {
        reachedOlderThanRange = true;
        break;
      }
      if (pub.day > endDate) continue; // 종료일보다 최신이면 건너뜀
      collected.push({
        title: cleanHtml(it.title),
        date: pub.label,
        source: domainOf(it.originallink || it.link || ""),
        body: cleanHtml(it.description), // 우선 요약으로 채움
        link: it.link || it.originallink || "",
        originallink: it.originallink || "",
      });
      if (collected.length >= maxCount) break;
    }

    if (reachedOlderThanRange || collected.length >= maxCount) break;
    if (items.length < API_DISPLAY) break; // 마지막 페이지
    if (start + API_DISPLAY > API_MAX_START) hitApiLimit = true;
  }

  const warning = hitApiLimit && !reachedOlderThanRange
    ? "네이버 API 한도(최신 1,000건)에 도달했습니다. 지정한 기간의 더 오래된 기사는 조회되지 않을 수 있습니다."
    : null;
  return { articles: collected, warning };
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
