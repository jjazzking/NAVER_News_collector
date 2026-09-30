// 배포용(법인) 사이트 설정. 배포 시 docs/index.html · ai-export.js 가 이 폴더(corp/)로 복사되어 함께 쓰인다.
// 사용자가 화면에 입력한 NAVER API HUB 키로 검색하는 함수(naver-news-corp)를 호출한다.
window.NAVER_NEWS_FUNCTION_URL = "https://adqrvvcsvuageemtaljw.supabase.co/functions/v1/naver-news-corp";
window.NEWS_COLLECTOR_MODE = "corp";
