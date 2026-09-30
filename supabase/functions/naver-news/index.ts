// 본인용 사이트(docs/)가 호출하는 함수. 네이버 API 키는 Supabase secrets 에 저장된 것을 쓴다.
import { createHandler } from "../_shared/news.ts";

Deno.serve(createHandler("server"));
