export const MOJIBAKE_MARKER =
  /\uFFFD|[?]{2,}|[\u0080-\u009F]|[\uF900-\uFAFF]|\u00C3.|\u00C2.|\u00E2\u20AC|\u00EC[\u0080-\u00BF]|\u00ED[\u0080-\u00BF]|\u00EB[\u0080-\u00BF]|\u00EA[\u0080-\u00BF]/u;

export const KOREAN_UTF8_SENTINELS = Object.freeze(["한글 질문", "근거 추적성", "설정 부족", "검색 snippet은 evidence가 아님"]);
