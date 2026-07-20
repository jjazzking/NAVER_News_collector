"""네이버 뉴스 검색 정리 툴 (Flask)

키워드 + 기간을 입력하면 네이버 검색 API로 뉴스를 모아
[제목 | 일자 | 출처 | 주요 내용(본문)] 형태로 정리하고 CSV/Excel로 내려받는다.
"""
import csv
import io
import os
import re
import html
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from flask import Flask, jsonify, render_template, request, send_file

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)

NAVER_NEWS_API = "https://openapi.naver.com/v1/search/news.json"
API_MAX_START = 1000          # 네이버 API는 start+display <= 1000 까지만 허용
API_DISPLAY = 100             # 한 페이지 최대 100건
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


# --------------------------------------------------------------------------- #
# 유틸
# --------------------------------------------------------------------------- #
def clean_html(text: str) -> str:
    """API가 주는 제목/요약의 <b> 태그와 HTML 엔티티를 제거한다."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def parse_pub_date(pub_date_str: str):
    """RFC1123 형식(pubDate)을 KST 기준 date 로 변환."""
    try:
        dt = parsedate_to_datetime(pub_date_str)
        return dt.date(), dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return None, pub_date_str


def domain_of(url: str) -> str:
    try:
        host = urlparse(url).netloc
        return host.replace("www.", "")
    except Exception:
        return ""


# --------------------------------------------------------------------------- #
# 본문 / 출처 추출 (기사 링크에 실제 접속)
# --------------------------------------------------------------------------- #
BODY_SELECTORS = [
    "#dic_area",              # 네이버 뉴스 (신형)
    "#newsct_article",        # 네이버 뉴스
    ".newsct_article",
    "#articeBody",            # 네이버 연예/스포츠
    "#articleBodyContents",   # 네이버 뉴스 (구형)
    "article",                # 일반 언론사 폴백
]


def extract_body_and_source(url: str, timeout: int = 8):
    """기사 링크에 접속해 본문 텍스트와 출처(언론사)를 best-effort 로 뽑는다."""
    fallback_source = domain_of(url)
    try:
        resp = requests.get(url, headers={"User-Agent": UA}, timeout=timeout)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or resp.encoding
        soup = BeautifulSoup(resp.text, "lxml")
    except Exception:
        return "", fallback_source

    # 출처(언론사) 추출
    source = fallback_source
    logo = soup.select_one(".media_end_head_top_logo img, .press_logo img, a.media_end_head_top_logo_img img")
    if logo and logo.get("alt"):
        source = logo.get("alt").strip()
    else:
        meta = soup.select_one('meta[property="og:site_name"]')
        if meta and meta.get("content") and meta["content"].strip() not in ("네이버 뉴스", "NAVER"):
            source = meta["content"].strip()

    # 본문 추출
    body = ""
    for sel in BODY_SELECTORS:
        node = soup.select_one(sel)
        if node:
            for junk in node.select("script, style"):
                junk.decompose()
            body = node.get_text(separator="\n", strip=True)
            if len(body) > 50:
                break

    if not body:
        meta_desc = soup.select_one('meta[property="og:description"]')
        if meta_desc and meta_desc.get("content"):
            body = meta_desc["content"].strip()

    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return body, source


# --------------------------------------------------------------------------- #
# 검색
# --------------------------------------------------------------------------- #
def search_news(client_id, client_secret, keyword, start_date, end_date,
                fetch_body=True, max_count=200):
    """네이버 뉴스 검색 → 기간 필터 → (선택) 본문 수집."""
    headers = {
        "X-Naver-Client-Id": client_id,
        "X-Naver-Client-Secret": client_secret,
    }
    collected = []
    reached_older_than_range = False
    hit_api_limit = False

    start = 1
    while start <= API_MAX_START:
        params = {
            "query": keyword,
            "display": API_DISPLAY,
            "start": start,
            "sort": "date",  # 최신순 (기간 필터를 위해 필수)
        }
        resp = requests.get(NAVER_NEWS_API, headers=headers, params=params, timeout=10)
        if resp.status_code == 401:
            raise PermissionError("인증 실패: Client ID / Secret 을 확인하세요.")
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            break

        for it in items:
            pub_date, pub_str = parse_pub_date(it.get("pubDate", ""))
            if pub_date is None:
                continue
            # 최신순이므로 시작일보다 과거면 이후 항목도 전부 과거 → 종료
            if pub_date < start_date:
                reached_older_than_range = True
                break
            if pub_date > end_date:
                continue  # 종료일보다 미래(더 최신)면 건너뜀
            collected.append({
                "title": clean_html(it.get("title", "")),
                "date": pub_str,
                "source": domain_of(it.get("originallink") or it.get("link", "")),
                "body": clean_html(it.get("description", "")),  # 우선 요약으로 채움
                "link": it.get("link") or it.get("originallink", ""),
                "originallink": it.get("originallink", ""),
            })
            if len(collected) >= max_count:
                break

        if reached_older_than_range or len(collected) >= max_count:
            break
        start += API_DISPLAY
        if start > API_MAX_START:
            hit_api_limit = True

    # 본문 수집 (병렬)
    if fetch_body and collected:
        def _enrich(article):
            url = article["link"] or article["originallink"]
            body, source = extract_body_and_source(url)
            if body:
                article["body"] = body
            if source:
                article["source"] = source
            return article

        with ThreadPoolExecutor(max_workers=8) as ex:
            collected = list(ex.map(_enrich, collected))

    warning = None
    if hit_api_limit and not reached_older_than_range:
        warning = ("네이버 API 한도(최신 1,000건)에 도달했습니다. "
                   "지정한 기간의 더 오래된 기사는 조회되지 않을 수 있습니다.")

    return collected, warning


# --------------------------------------------------------------------------- #
# 라우트
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template(
        "index.html",
        default_id=os.getenv("NAVER_CLIENT_ID", ""),
        default_secret=os.getenv("NAVER_CLIENT_SECRET", ""),
    )


@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(force=True)
    client_id = (data.get("client_id") or "").strip()
    client_secret = (data.get("client_secret") or "").strip()
    keyword = (data.get("keyword") or "").strip()

    if not (client_id and client_secret):
        return jsonify({"error": "Client ID / Secret 을 입력하세요."}), 400
    if not keyword:
        return jsonify({"error": "검색 키워드를 입력하세요."}), 400

    try:
        start_date = datetime.strptime(data["start_date"], "%Y-%m-%d").date()
        end_date = datetime.strptime(data["end_date"], "%Y-%m-%d").date()
    except (KeyError, ValueError):
        return jsonify({"error": "기간(시작일/종료일)을 올바르게 입력하세요."}), 400
    if start_date > end_date:
        return jsonify({"error": "시작일이 종료일보다 늦습니다."}), 400

    fetch_body = bool(data.get("fetch_body", True))
    try:
        max_count = min(int(data.get("max_count", 200)), 1000)
    except (TypeError, ValueError):
        max_count = 200

    try:
        articles, warning = search_news(
            client_id, client_secret, keyword,
            start_date, end_date, fetch_body, max_count,
        )
    except PermissionError as e:
        return jsonify({"error": str(e)}), 401
    except requests.RequestException as e:
        return jsonify({"error": f"네이버 API 요청 실패: {e}"}), 502

    return jsonify({"count": len(articles), "articles": articles, "warning": warning})


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.get_json(force=True)
    articles = data.get("articles", [])
    fmt = data.get("format", "csv")
    keyword = (data.get("keyword") or "news").strip()
    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    safe_kw = re.sub(r"[^\w가-힣]+", "_", keyword)[:30] or "news"

    headers = ["제목", "일자", "출처", "주요 내용", "링크"]
    rows = [[a.get("title", ""), a.get("date", ""), a.get("source", ""),
             a.get("body", ""), a.get("link", "")] for a in articles]

    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font

        wb = Workbook()
        ws = wb.active
        ws.title = "뉴스"
        ws.append(headers)
        for c in ws[1]:
            c.font = Font(bold=True)
        for r in rows:
            ws.append(r)
        widths = [50, 18, 18, 80, 40]
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[chr(64 + i)].width = w
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(vertical="top", wrap_text=True)
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return send_file(
            buf, as_attachment=True,
            download_name=f"naver_news_{safe_kw}_{stamp}.xlsx",
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

    # CSV (Excel 한글 깨짐 방지용 BOM 포함)
    sio = io.StringIO()
    writer = csv.writer(sio)
    writer.writerow(headers)
    writer.writerows(rows)
    buf = io.BytesIO(("﻿" + sio.getvalue()).encode("utf-8"))
    buf.seek(0)
    return send_file(
        buf, as_attachment=True,
        download_name=f"naver_news_{safe_kw}_{stamp}.csv",
        mimetype="text/csv",
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
