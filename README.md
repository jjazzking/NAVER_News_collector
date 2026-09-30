# 📰 네이버 뉴스 검색 정리 툴

키워드와 기간을 입력하면 **네이버 검색 API**로 뉴스를 모아
`제목 · 일자 · 출처 · 주요 내용(본문)` 형태로 정리하고 **CSV / Excel**로 내려받는 간단한 웹 툴.

구성: GitHub Pages(`docs/`) 화면 + Supabase Edge Function(`supabase/`). 서버를 켤 필요 없이 URL로 접속하고, API 키는 Supabase에만 저장됩니다.
먼저 네이버 API 키를 발급받으세요.

## 네이버 API 키 발급 (1회)

NAVER Cloud 콘솔의 **NAVER API HUB** 에서 발급받은 키를 사용합니다.
(호출 주소 `naverapihub.apigw.ntruss.com/search/v1/news`, 인증 헤더 `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY`)

1. NAVER Cloud 콘솔 → **Application Services → NAVER API HUB → Application**
2. Application 등록(또는 수정) 화면에서 API 목록 중 **뉴스** (`NAVER_SCH_NEWS`) 체크 → 저장
3. Application 의 인증 정보에서 **Client ID / Client Secret** 복사

> 검색 API 하루 호출 한도는 25,000회입니다.

---

# 배포 (Supabase + GitHub Pages)

사이트 두 개가 같은 화면 코드와 같은 검색 로직을 공유합니다.

| 사이트 | 주소 | 호출하는 함수 | 네이버 API 키 |
|---|---|---|---|
| 본인용 | `…/NAVER_News_collector/` | `naver-news` | Supabase secrets 에 저장된 키 |
| 배포용 | `…/NAVER_News_collector/corp/` | `naver-news-corp` | 사용자가 화면에 입력 (브라우저에만 저장). 키가 없으면 함수가 거절 |

```
GitHub Pages  /  (docs/index.html + docs/config.js)
              /corp/  (같은 index.html + docs/corp/config.js, 키 입력·이용 안내 탭)
      │  fetch
      ▼
Supabase Edge Functions
  naver-news       (supabase/functions/naver-news/index.ts)       서버 키 사용
  naver-news-corp  (supabase/functions/naver-news-corp/index.ts)  요청 본문의 사용자 키 사용
  └ 공통 로직: supabase/functions/_shared/news.ts
      - action "search" : 네이버 뉴스 검색(최신순 + 정확도순) + 기간 필터
      - action "bodies" : 기사 링크에 접속해 본문/언론사 추출 (한 번에 최대 20건)
```

> 배포용 함수는 사용자 키를 요청 헤더가 아니라 **본문**으로 받습니다(헤더는 플랫폼 로그에 남을 수 있음). 받은 키는 네이버 호출에만 쓰고 저장·기록하지 않습니다.

> 네이버 API는 브라우저에서 직접 호출할 수 없어서(CORS 미지원, Secret 노출 문제) Edge Function이 대신 호출합니다.
> 본문 수집은 함수 실행 시간 제한 때문에 화면에서 20건씩 나눠 요청하고, CSV / Excel 파일은 브라우저에서 바로 만듭니다.

## 1. Supabase 프로젝트 만들기

1. [supabase.com](https://supabase.com) 가입 → **New project** (무료 플랜으로 충분)
2. 대시보드 → **Project Settings → General** 의 **Project ID**(`<project-ref>`)를 메모
   함수 주소는 `https://<project-ref>.supabase.co/functions/v1/naver-news` 가 됩니다.

## 2. Edge Function 배포

### 방법 A. Supabase CLI (권장)

Node.js가 설치되어 있으면 `npx`로 바로 쓸 수 있습니다.

```bash
cd NAVER_News_collector
npx supabase login
npx supabase link --project-ref <project-ref>

# 네이버 API 키 등록 (서버에만 저장됨)
# secrets 는 프로젝트 전체가 공유하므로 다른 함수와 겹치지 않도록 NEWS_COLLECTOR_ 접두사를 씁니다.
npx supabase secrets set NEWS_COLLECTOR_NAVER_CLIENT_ID=발급받은ID NEWS_COLLECTOR_NAVER_CLIENT_SECRET=발급받은Secret

# 배포 (로그인 없이 호출할 수 있도록 JWT 검사 해제). 두 함수 모두 배포합니다.
npx supabase functions deploy naver-news --no-verify-jwt
npx supabase functions deploy naver-news-corp --no-verify-jwt
```

`supabase/functions/_shared/news.ts` 를 고치면 **두 함수 모두** 다시 배포해야 합니다.

### 방법 B. GitHub Actions (프로그램 설치 없이, 브라우저만으로)

`.github/workflows/deploy-functions.yml` 이 두 함수를 배포합니다. `main` 에 `supabase/` 변경이 합쳐지면 자동으로 돌고, 수동으로도 돌릴 수 있습니다.

1. Supabase 대시보드 → 오른쪽 위 계정 메뉴 → **Account preferences → Access Tokens** → **Generate new token** → 토큰 복사
   (이 토큰은 본인 계정의 모든 Supabase 프로젝트를 다룰 수 있으므로 다른 곳에 공유하지 마세요)
2. GitHub 레포 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SUPABASE_ACCESS_TOKEN`, Secret: 1번 토큰
3. **Actions → Deploy Supabase Functions → Run workflow** (처음 한 번). 이후에는 `supabase/` 가 바뀌어 `main` 에 합쳐질 때 자동 배포됩니다.
4. 다른 Supabase 프로젝트로 옮길 때는 워크플로 파일의 `PROJECT_REF` 를 바꿉니다.

네이버 API 키 secrets(`NEWS_COLLECTOR_NAVER_CLIENT_ID` / `_SECRET`)는 대시보드 **Edge Functions → Secrets** 에서 등록합니다.

> 두 함수가 공통 파일(`_shared/news.ts`)을 함께 쓰므로, 대시보드 편집기에 코드를 붙여넣는 방식은 쓸 수 없습니다.

### 배포 확인

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/naver-news \
  -H "Content-Type: application/json" \
  -d '{"action":"search","keyword":"날씨","start_date":"2020-01-01","end_date":"2099-12-31","max_count":3}'
```

기사 목록 JSON이 나오면 성공입니다. 실패하면 응답의 `error` 메시지에 원인이 적혀 있습니다.

| 에러 | 해결 |
|---|---|
| `NEWS_COLLECTOR_NAVER_CLIENT_ID / NEWS_COLLECTOR_NAVER_CLIENT_SECRET 이 설정되지 않았습니다` | secrets 등록 후 다시 시도 |
| `네이버 인증 실패` (401) | NAVER API HUB 의 Client ID / Secret 오타 확인 |
| `네이버 API 권한 없음` (403) | NAVER API HUB → Application 에 "뉴스" API 선택·저장, Subscription 확인 |
| `Invalid JWT` / `Missing authorization header` | JWT 검사 해제(`--no-verify-jwt`) 후 재배포 |

## 3. GitHub Pages 설정

1. `docs/config.js` 의 `<project-ref>` 를 본인 값으로 바꾸고 커밋/푸시
   ```js
   window.NAVER_NEWS_FUNCTION_URL = "https://abcdefghijkl.supabase.co/functions/v1/naver-news";
   ```
2. GitHub 레포 → **Settings → Pages** → Source: **GitHub Actions** 선택
   - `main` 에 `docs/` 변경이 푸시될 때마다 `.github/workflows/pages.yml` 이 자동 배포합니다.
   - 수동 배포: **Actions → Deploy GitHub Pages → Run workflow**
3. 1~2분 뒤 접속
   - 본인용: `https://<GitHub 아이디>.github.io/NAVER_News_collector/`
   - 배포용: `https://<GitHub 아이디>.github.io/NAVER_News_collector/corp/`

### 배포용 사이트 (`/corp/`)

- 설정은 `docs/corp/config.js` 하나입니다 (`naver-news-corp` 함수 주소 + 배포용 모드). 화면 코드(`docs/index.html`, `docs/ai-export.js`)는 배포할 때 이 폴더로 복사되어 쓰이므로 따로 고칠 필요가 없습니다.
  - 그래서 `docs/corp/` 폴더를 로컬에서 바로 열면 동작하지 않습니다. 배포된 주소로 확인하세요.
- **이용 안내** 탭의 캡처는 `docs/corp/guide/` 에 정해진 이름의 PNG 를 넣으면 자동으로 표시됩니다. 파일 목록은 [`docs/corp/guide/README.md`](docs/corp/guide/README.md) 참고. 없는 캡처는 "캡처 준비 중" 자리로 표시됩니다.
- 사용자 키는 사용자 브라우저에만 저장되며("이 브라우저에 저장"을 끄면 저장하지 않음), 사용자마다 네이버 호출 한도가 따로 적용됩니다.

## 4. (선택) 다른 사이트에서의 호출 막기

로그인이 없어서 함수 주소를 아는 사람은 누구나 호출할 수 있습니다(네이버 API 하루 25,000회 한도를 같이 쓰게 됨).
아래처럼 설정하면 내 GitHub Pages 에서 온 브라우저 요청만 허용합니다.

```bash
npx supabase secrets set NEWS_COLLECTOR_ALLOWED_ORIGINS=https://<GitHub 아이디>.github.io
```

> 브라우저 기준의 제한이라 curl 등으로 직접 호출하는 것까지 막지는 못합니다.

## 5. AI 분석용 내보내기 (Copilot 등)

검색 결과를 사내 AI(Copilot 등)에 넘겨 **이슈별 분류 + 1~2줄 요약**을 받기 위한 기능입니다. AI API는 호출하지 않고, 파일과 지시문만 만듭니다.

1. 검색이 끝나면 결과 표 아래 **🤖 AI 분석용 내보내기**에서 회사명과 다른 이름(약칭·영문명)을 입력
2. **JSON 내보내기** → `ai_input_*.json` 저장
3. **지시문 복사**(또는 다운로드) → AI 대화창에 붙여넣고 JSON 파일 첨부
4. AI가 이슈별 일자·제목·1~2줄 요약·대표 기사 링크를 JSON, 표, 엑셀(.xlsx) 파일로 출력 (파일을 못 만드는 환경이면 CSV)

본문 전체 대신 기사마다 **핵심 발췌**를 넣어 분량을 줄입니다.

- 발췌 = 기사 앞 2~3문장 + 회사명/다른 이름이 들어간 문장 (길이: 짧게 약 300자 / 보통 약 600자 / 본문 전체)
- 기자 이름·이메일·저작권 문구·사진 설명 등 제거
- 제목이 거의 같은 기사(다른 매체의 전재 기사)는 하나로 합침 (숫자가 다른 제목은 합치지 않음)
- 회사명이 제목·본문에 없는 기사는 `company_mentioned: false` 로 표시 → AI가 결과에서 제외
- 분량이 "파일당 최대 글자 수"를 넘으면 여러 파일로 나눠 저장되고, 지시문에 순서대로 보내는 방법이 함께 들어갑니다.

---

# 사용 안내

## 사용법

1. 검색 키워드 입력 — 회사를 부르는 이름이 여러 개면 쉼표로 구분 (예: `포스코인터내셔널, 포스코인터`). 이름마다 따로 검색해 중복을 합친 하나의 결과로 보여줍니다.
2. 시작일 / 종료일 선택
3. **기사 본문 전체 수집** 체크 여부 결정
   - ✅ 체크: 각 기사 링크에 접속해 본문 전체를 "주요 내용"에 채움 (느림)
   - ⬜ 해제: API가 주는 짧은 요약만 채움 (빠름)
4. **검색** → 표로 확인 → **CSV / Excel 다운로드**

## 출력 컬럼

| 제목 | 일자 | 출처 | 주요 내용 | 링크 |
|---|---|---|---|---|

## ⚠️ 알아둘 제약

- **기간 필터**: 네이버 검색 API에는 날짜 파라미터가 없어, 받아온 기사 중 지정 기간 안의 것만 남기는 방식입니다.
- **최대 1,000건**: API는 한 검색어·정렬당 1,000건까지만 조회 가능합니다. 기사가 많은 회사는 최신순 1,000건이 최근 한 달 안팎에서 끝납니다.
  - 그래서 최신순과 **정확도순**을 함께 가져와 합칩니다. 정확도순은 날짜와 무관하게 관련도 높은 기사를 주므로 더 오래된 기간도 일부 채워지지만, 그 기간은 관련도 높은 기사 위주라 빠진 기사가 있을 수 있습니다(경고로 표시).
  - 합친 결과가 "최대 수집 건수"보다 많으면 기간 전체에서 고르게 추립니다.
- **본문/출처 추출**: 네이버 뉴스(`n.news.naver.com`) 링크는 잘 추출됩니다. 외부 언론사 페이지는 구조가 제각각이라 일부 기사는 본문이 비거나 요약만 채워질 수 있습니다(best-effort).

- 
