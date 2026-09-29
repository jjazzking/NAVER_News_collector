# 📰 네이버 뉴스 검색 정리 툴

키워드와 기간을 입력하면 **네이버 검색 API**로 뉴스를 모아
`제목 · 일자 · 출처 · 주요 내용(본문)` 형태로 정리하고 **CSV / Excel**로 내려받는 간단한 웹 툴.

두 가지 버전이 있습니다. 어느 쪽이든 먼저 네이버 API 키를 발급받으세요.

| 버전 | 구성 | 특징 |
|---|---|---|
| [**웹 버전**](#웹-버전-supabase--github-pages) | GitHub Pages(`docs/`) + Supabase Edge Function(`supabase/`) | 서버를 켤 필요 없이 URL로 접속, 폰에서도 사용 가능. API 키는 Supabase에만 저장 |
| [**로컬 버전**](#로컬-버전-python) | Python Flask(`app.py`) | 내 PC에서 실행 |

## 네이버 API 키 발급 (1회)

1. [네이버 개발자센터](https://developers.naver.com) 로그인
2. **Application → 애플리케이션 등록**
3. 사용 API에서 **검색** 선택, 환경은 **WEB 설정**(주소는 `http://localhost` 아무거나)
4. 발급된 **Client ID / Client Secret** 복사

> 무료. 하루 25,000회 호출 가능.

---

# 웹 버전 (Supabase + GitHub Pages)

```
GitHub Pages (docs/index.html)
      │  fetch
      ▼
Supabase Edge Function "naver-news" (supabase/functions/naver-news/index.ts)
  - 네이버 API 키는 Supabase secrets 에 저장 (화면에 노출 안 됨)
  - action "search" : 네이버 뉴스 검색 + 기간 필터
  - action "bodies" : 기사 링크에 접속해 본문/언론사 추출 (한 번에 최대 20건)
```

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
npx supabase secrets set NAVER_CLIENT_ID=발급받은ID NAVER_CLIENT_SECRET=발급받은Secret

# 배포 (로그인 없이 호출할 수 있도록 JWT 검사 해제)
npx supabase functions deploy naver-news --no-verify-jwt
```

### 방법 B. 대시보드에서 직접

1. 대시보드 → **Edge Functions** → **Deploy a new function** → **Via Editor**
2. 함수 이름 `naver-news`, 코드 칸에 `supabase/functions/naver-news/index.ts` 내용을 전부 붙여넣고 Deploy
3. 함수 상세 화면 → **Details** 에서 **JWT 검사(Verify JWT)** 를 **끄고** 저장
4. **Edge Functions → Secrets** 에서 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` 추가

### 배포 확인

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/naver-news \
  -H "Content-Type: application/json" \
  -d '{"action":"search","keyword":"날씨","start_date":"2020-01-01","end_date":"2099-12-31","max_count":3}'
```

기사 목록 JSON이 나오면 성공입니다. 실패하면 응답의 `error` 메시지에 원인이 적혀 있습니다.

| 에러 | 해결 |
|---|---|
| `NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 설정되지 않았습니다` | secrets 등록 후 다시 시도 |
| `네이버 인증 실패` (401) | Client ID / Secret 오타 확인 |
| `네이버 API 권한 없음` (403) | 개발자센터 애플리케이션에 "검색" API 추가 |
| `Invalid JWT` / `Missing authorization header` | JWT 검사 해제(`--no-verify-jwt`) 후 재배포 |

## 3. GitHub Pages 설정

1. `docs/config.js` 의 `<project-ref>` 를 본인 값으로 바꾸고 커밋/푸시
   ```js
   window.NAVER_NEWS_FUNCTION_URL = "https://abcdefghijkl.supabase.co/functions/v1/naver-news";
   ```
2. GitHub 레포 → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, 폴더: `/docs` → Save
3. 1~2분 뒤 `https://<GitHub 아이디>.github.io/NAVER_News_collector/` 접속

## 4. (선택) 다른 사이트에서의 호출 막기

로그인이 없어서 함수 주소를 아는 사람은 누구나 호출할 수 있습니다(네이버 API 하루 25,000회 한도를 같이 쓰게 됨).
아래처럼 설정하면 내 GitHub Pages 에서 온 브라우저 요청만 허용합니다.

```bash
npx supabase secrets set ALLOWED_ORIGINS=https://<GitHub 아이디>.github.io
```

> 브라우저 기준의 제한이라 curl 등으로 직접 호출하는 것까지 막지는 못합니다.

---

# 로컬 버전 (Python)

## 설치 & 실행

```bash
cd NAVER_News_collector
python3 -m pip install -r requirements.txt
python3 app.py
```

브라우저에서 **http://localhost:5000** 접속.

- 처음 화면 상단 `🔑 API 인증 정보`에 Client ID / Secret 입력 (브라우저에 저장되어 다음부턴 생략)
- 또는 `.env.example`을 `.env`로 복사해 키를 넣어두면 자동 입력됨

## 사용법

1. 검색 키워드 입력
2. 시작일 / 종료일 선택
3. **기사 본문 전체 수집** 체크 여부 결정
   - ✅ 체크: 각 기사 링크에 접속해 본문 전체를 "주요 내용"에 채움 (느림)
   - ⬜ 해제: API가 주는 짧은 요약만 채움 (빠름)
4. **검색** → 표로 확인 → **CSV / Excel 다운로드**

## 출력 컬럼

| 제목 | 일자 | 출처 | 주요 내용 | 링크 |
|---|---|---|---|---|

## ⚠️ 알아둘 제약

- **기간 필터**: 네이버 검색 API에는 날짜 파라미터가 없어, 최신순으로 받아오며 지정 기간을 벗어나면 멈추는 방식입니다.
- **최대 1,000건**: API는 한 키워드당 최신 1,000건까지만 조회 가능합니다. 아주 오래된 기간을 조회하면 그 구간에 도달하기 전에 한도에 걸릴 수 있고, 이 경우 경고가 표시됩니다.
- **본문/출처 추출**: 네이버 뉴스(`n.news.naver.com`) 링크는 잘 추출됩니다. 외부 언론사 페이지는 구조가 제각각이라 일부 기사는 본문이 비거나 요약만 채워질 수 있습니다(best-effort).
