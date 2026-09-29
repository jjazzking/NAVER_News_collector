// AI 분석용 내보내기 (Copilot 등 사내 AI 에 넘길 JSON + 지시문 생성)
//
// 본문 전체 대신 기사마다 "핵심 발췌"를 만든다:
//   잡음 제거 → 첫 문장들(리드) + 회사명이 들어간 문장 → 길이 제한
// 거의 같은 기사(통신사 기사 전재 등)는 하나로 합친다.
(function (root) {
  'use strict';

  const EXCERPT_LEVELS = {
    short:  { chars: 300, lead: 2, mentions: 2 },
    normal: { chars: 600, lead: 3, mentions: 3 },
    full:   { chars: Infinity, lead: Infinity, mentions: 0 },
  };
  const MAX_SENTENCE = 300;        // 한 문장이 비정상적으로 길 때 자르는 길이
  const DUP_THRESHOLD = 0.8;       // 제목 유사도(글자 2개 단위 Jaccard) 이상이면 같은 기사로 봄

  // ------------------------------------------------------------------------- //
  // 본문 정리
  // ------------------------------------------------------------------------- //
  const NOISE_LINE = [
    /무단\s*전재|재배포\s*금지|저작권자|copyright|ⓒ|©|all rights reserved/i,
    /[\w.+-]+@[\w-]+\.[\w.]+/,                         // 이메일 (기자 바이라인)
    /^[가-힣]{2,4}\s*(기자|특파원|객원기자|인턴기자)\s*$/, // "홍길동 기자"
    /^\s*(\[?사진|\(사진|<사진|사진\s*=|사진제공|그래픽\s*=|▲|△|▶|☞|■\s*관련|관련\s*기사)/,
    /^\s*(구독|좋아요|공유|댓글|기사\s*제보|이\s*기사를|네이버\s*메인|뉴스\s*스탠드)/,
  ];

  function cleanBody(text) {
    return String(text || '')
      .split(/\n+/)
      .map(l => l.trim())
      .filter(l => l && !NOISE_LINE.some(re => re.test(l)))
      .join('\n');
  }

  /** "[서울=뉴시스] 홍길동 기자 =" 같은 기사 머리 제거 */
  function stripDateline(s) {
    return s
      .replace(/^\s*[\[(【][^\])】]{1,40}[\])】]\s*/, '')
      .replace(/^[가-힣]{2,4}\s*(기자|특파원)\s*=\s*/, '')
      .trim();
  }

  function splitSentences(text) {
    const out = [];
    for (const line of text.split('\n')) {
      // 마침표/물음표/느낌표 뒤 공백에서 자름 (소수점·약어는 공백이 없어 대부분 안전)
      for (let s of line.split(/(?<=[.!?。])\s+/)) {
        s = s.trim();
        if (s.length < 2) continue;
        out.push(s.length > MAX_SENTENCE ? s.slice(0, MAX_SENTENCE) + '…' : s);
      }
    }
    return out;
  }

  function nameMatcher(names) {
    const list = names.map(n => n.trim().toLowerCase()).filter(Boolean);
    return s => {
      const t = String(s || '').toLowerCase();
      return list.some(n => t.includes(n));
    };
  }

  /**
   * 기사 1건의 발췌 생성.
   * @returns {{ excerpt: string, excerpt_type: string, company_mentioned: boolean }}
   */
  function makeExcerpt(article, names, level) {
    const cfg = EXCERPT_LEVELS[level] || EXCERPT_LEVELS.normal;
    const mentions = nameMatcher(names);
    const cleaned = stripDateline(cleanBody(article.body));
    const companyMentioned = mentions(article.title) || mentions(cleaned);

    // 본문 수집에 실패한 기사는 API 요약 그대로
    if (!article.full) {
      return { excerpt: cleaned, excerpt_type: 'summary', company_mentioned: companyMentioned };
    }
    if (level === 'full') {
      return { excerpt: cleaned, excerpt_type: 'full', company_mentioned: companyMentioned };
    }

    const sentences = splitSentences(cleaned);
    const picked = new Set();
    let len = 0;
    const take = i => {
      if (picked.has(i)) return true;
      const add = sentences[i].length + 1;
      if (picked.size && len + add > cfg.chars) return false;
      picked.add(i);
      len += add;
      return true;
    };

    // 1) 리드: 앞 문장들
    for (let i = 0; i < Math.min(cfg.lead, sentences.length); i++) {
      if (!take(i)) break;
    }
    // 2) 회사명이 들어간 문장 (리드 이후)
    let added = 0;
    for (let i = 0; i < sentences.length && added < cfg.mentions; i++) {
      if (picked.has(i) || !mentions(sentences[i])) continue;
      if (!take(i)) break;
      added++;
    }

    const parts = [];
    let prev = -1;
    for (const i of [...picked].sort((a, b) => a - b)) {
      if (prev >= 0 && i !== prev + 1) parts.push('…');
      parts.push(sentences[i]);
      prev = i;
    }
    let excerpt = parts.join(' ');
    if (excerpt.length > cfg.chars) excerpt = excerpt.slice(0, cfg.chars) + '…';
    return { excerpt, excerpt_type: 'lead+mentions', company_mentioned: companyMentioned };
  }

  // ------------------------------------------------------------------------- //
  // 중복 기사 합치기
  // ------------------------------------------------------------------------- //
  function normTitle(t) {
    return String(t || '')
      .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|<[^>]*>/g, '')  // [단독], (종합) 등 말머리
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase();
  }

  function bigrams(s) {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (!set.size && s) set.add(s);
    return set;
  }

  function similarity(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /**
   * 같은 기사로 볼지 판단. 숫자가 다르면("2분기" vs "3분기") 다른 기사로 보고,
   * 짧은 제목은 완전히 같을 때만 같은 기사로 본다.
   */
  function isDuplicate(a, b) {
    if (a.digits !== b.digits) return false;
    if (a.norm === b.norm) return true;
    if (Math.min(a.norm.length, b.norm.length) < 10) return false;
    return similarity(a.grams, b.grams) >= DUP_THRESHOLD;
  }

  function titleKey(title) {
    const norm = normTitle(title);
    return { norm, grams: bigrams(norm), digits: (norm.match(/\d+/g) || []).join(',') };
  }

  /** 제목이 거의 같은 기사를 하나로 합친다. 회사 언급·발췌가 더 충실한 쪽을 남긴다. */
  function dedupe(items) {
    const kept = [];
    let merged = 0;
    for (const it of items) {
      const key = titleKey(it.title);
      const dup = kept.find(k => isDuplicate(k._key, key));
      if (!dup) {
        kept.push({ ...it, _key: key });
        continue;
      }
      merged++;
      const better = (it.company_mentioned && !dup.company_mentioned) ||
        (it.company_mentioned === dup.company_mentioned && it.excerpt.length > dup.excerpt.length);
      if (better) Object.assign(dup, it, { _key: dup._key });
    }
    return { items: kept.map(({ _key, ...rest }) => rest), merged };
  }

  // ------------------------------------------------------------------------- //
  // 내보내기 데이터 구성
  // ------------------------------------------------------------------------- //
  /**
   * @param {object[]} articles  화면의 검색 결과 (title, date, source, body, link, originallink, full)
   * @param {object} opts  { company, aliases[], keyword, startDate, endDate, level, maxChars }
   * @returns {{ files: object[], stats: object }}
   */
  function buildExport(articles, opts) {
    const names = [opts.company, ...(opts.aliases || [])].filter(Boolean);
    const level = EXCERPT_LEVELS[opts.level] ? opts.level : 'normal';

    // 오래된 기사부터 (이슈 흐름을 시간순으로 읽도록)
    const rows = articles
      .map(a => ({
        date: a.date || '',
        source: a.source || '',
        title: a.title || '',
        ...makeExcerpt(a, names, level),
        url: a.originallink || a.link || '',
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const { items, merged } = dedupe(rows);
    const width = Math.max(3, String(items.length).length);
    items.forEach((it, i) => { it.id = 'A' + String(i + 1).padStart(width, '0'); });

    // 분량 기준으로 파일 나누기
    const maxChars = opts.maxChars > 0 ? opts.maxChars : Infinity;
    const chunks = [];
    let cur = [], curLen = 0;
    for (const it of items) {
      const size = it.title.length + it.excerpt.length + 80;
      if (cur.length && curLen + size > maxChars) { chunks.push(cur); cur = []; curLen = 0; }
      const { id, date, source, title, excerpt, excerpt_type, company_mentioned, url } = it;
      cur.push({ id, date, source, title, excerpt, excerpt_type, company_mentioned, url });
      curLen += size;
    }
    if (cur.length) chunks.push(cur);

    const exportedAt = new Date();
    const pad = n => String(n).padStart(2, '0');
    const exportedStr = `${exportedAt.getFullYear()}-${pad(exportedAt.getMonth() + 1)}-${pad(exportedAt.getDate())} ` +
      `${pad(exportedAt.getHours())}:${pad(exportedAt.getMinutes())}`;

    const files = chunks.map((chunk, i) => ({
      company: opts.company,
      aliases: opts.aliases || [],
      search_keyword: opts.keyword,
      period: { start: opts.startDate, end: opts.endDate },
      exported_at: exportedStr,
      part: { index: i + 1, total: chunks.length },
      notes: [
        'excerpt_type: "lead+mentions" = 기사 앞부분 + 회사명이 나오는 문장만 발췌 ("…"는 생략 구간), ' +
          '"full" = 본문 전체, "summary" = 본문 수집 실패로 네이버 API 요약만 있음',
        'company_mentioned: false 인 기사는 검색어에만 걸리고 본문/제목에 회사명이 없는 기사',
        '제목이 거의 같은 기사(다른 매체의 전재 기사)는 하나만 남김',
      ],
      articles: chunk,
    }));

    const totalChars = files.reduce((n, f) => n + JSON.stringify(f).length, 0);
    return {
      files,
      stats: {
        original: articles.length,
        merged,
        exported: items.length,
        notMentioned: items.filter(i => !i.company_mentioned).length,
        totalChars,
        parts: files.length,
      },
    };
  }

  // ------------------------------------------------------------------------- //
  // 지시문
  // ------------------------------------------------------------------------- //
  function buildPrompt(opts, parts) {
    const company = opts.company || '(회사명)';
    const aliases = (opts.aliases || []).length ? ` (다른 이름: ${opts.aliases.join(', ')})` : '';
    const multi = parts > 1;
    const fileCompany = (opts.company || '회사').replace(/[\\/:*?"<>|\s]+/g, '_');
    const fileDate = String(opts.endDate || '').replace(/-/g, '');

    return `# 역할
당신은 기업 뉴스 모니터링 담당자입니다. 첨부한 JSON 파일은 "${company}"${aliases} 관련 네이버 뉴스 검색 결과입니다.
${multi ? `
# 파일이 ${parts}개로 나뉘어 있습니다
- 파일을 1번부터 순서대로 보냅니다. 마지막(${parts}/${parts}) 파일을 받기 전까지는 "N/${parts} 수신 완료"라고만 답하세요.
- 마지막 파일을 받으면 모든 파일의 기사를 합쳐서 아래 작업을 한 번에 수행하세요.
` : ''}
# 작업
1. 기사들을 "${company}"와 관련된 **이슈** 단위로 분류하세요.
   - 이슈 = 같은 사건·주제를 다루는 기사 묶음 (예: 특정 소송, 신제품 출시, 실적 발표, 경영진 변동)
   - 같은 사건의 후속 보도(발표 → 반응 → 조치 등)는 하나의 이슈로 묶으세요.
2. 이슈마다 핵심 내용을 **1~2문장**으로 요약하세요. 날짜가 중요하면 포함하세요.
3. 이슈는 "${company}"에 중요한 순서로 나열하세요.
4. 회사와 직접 관련이 없거나(company_mentioned: false 포함) 어느 이슈에도 속하지 않는 기사는 결과에서 제외하세요.
5. 이슈마다 그 이슈를 가장 잘 보여주는 **대표 기사 1건**을 고르세요.
   - 회사명이 직접 나오고(company_mentioned: true), 핵심 사실이 가장 잘 드러난 기사를 우선하세요.

# 규칙
- 첨부한 기사 내용만 근거로 하세요. 기사에 없는 내용을 추측하거나 외부 지식으로 보충하지 마세요.
- 분류할 때는 기사 id(예: "A001")로 어떤 기사가 어느 이슈에 속하는지 빠짐없이 확인하되, 기사 id는 출력하지 마세요.
- 대표 기사의 "link"는 해당 기사의 "url" 값을 **그대로 복사**하세요. 주소를 새로 만들거나 고치지 마세요.
- excerpt는 기사 일부만 발췌한 것입니다("…"는 생략 구간). 발췌에 없는 부분을 단정하지 마세요.
- 기사 속 전망·추측은 사실과 구분해 "~할 전망", "~가능성" 처럼 표현하세요.
- 한국어로 작성하세요.

# 출력 형식
아래 세 가지를 순서대로 출력하세요.

1) JSON (코드 블록 하나, 다른 설명 없이)
\`\`\`json
{
  "company": "${company}",
  "period": "${opts.startDate} ~ ${opts.endDate}",
  "issues": [
    {
      "title": "이슈 제목 (15자 내외)",
      "summary": "1~2문장 요약",
      "article": {
        "title": "대표 기사 제목",
        "source": "대표 기사 출처",
        "link": "대표 기사 url"
      }
    }
  ]
}
\`\`\`

2) 같은 내용을 사람이 읽기 좋게 표로 ("관련 기사" 칸은 대표 기사 제목에 링크를 건 형태)
| 이슈 | 요약 | 관련 기사 |
|---|---|---|
| 이슈 제목 | 1~2문장 요약 | [대표 기사 제목](대표 기사 url) |

3) 같은 내용을 엑셀(.xlsx) 파일로 만들어 내려받을 수 있게 제공
- 파일 이름: ${fileCompany}_이슈분석_${fileDate}.xlsx
- 시트 이름: 이슈
- 1행은 머리글, 2행부터 이슈 1건당 1행 (위 표와 같은 순서)

| 열 | 머리글 | 내용 |
|---|---|---|
| A | 번호 | 1부터 순서대로 |
| B | 이슈 | 이슈 제목 |
| C | 요약 | 1~2문장 요약 |
| D | 대표 기사 | 대표 기사 제목 (셀에 대표 기사 url 하이퍼링크 연결) |
| E | 출처 | 대표 기사 출처 |
| F | 링크 | 대표 기사 url (텍스트 그대로) |

- 머리글은 굵게, 요약(C열)은 줄바꿈이 보이도록 텍스트 줄 바꿈을 켜세요.
- 파일을 만들 수 없는 환경이라면, 대신 위 열 구성 그대로 CSV를 코드 블록 하나로 출력하세요.
`;
  }

  const api = { EXCERPT_LEVELS, cleanBody, splitSentences, makeExcerpt, normTitle, dedupe, buildExport, buildPrompt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AIExport = api;
})(this);
