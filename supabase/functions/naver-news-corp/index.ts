// 배포용 사이트(docs/corp/)가 호출하는 함수. 사용자가 화면에 입력한 NAVER API HUB 키로만 검색하고,
// 키가 없으면 거절한다 (서버에 저장된 본인 키는 쓰지 않는다).
import { createHandler } from "../_shared/news.ts";

Deno.serve(createHandler("user"));
