# Plan: Daily Briefing·Compare Companies — 글로벌 공식 소스 기반 리서치 강화

## 0. 사용자 결정 사항 (인터뷰 완료)

- **모델**: Compare Companies와 Daily Briefing의 기업 opportunity/risk 분석 부분만 `claude-haiku-4-5-20251001` → `claude-sonnet-5`로 업그레이드. 새 버전 웹 검색 툴(`web_search_20260209`, dynamic filtering — 검색 결과를 코드 실행으로 걸러내 더 정교함)이 Sonnet 5 이상에서만 동작하고, 사용자가 명시한 "투자 등급 품질" 기준에 맞춰 더 나은 추론 품질이 필요하다고 판단해서 추천했고 사용자가 승인함. 앱의 다른 기능(Trend Analysis, Story Research, 일반 채팅)은 비용 효율을 위해 Haiku 그대로 유지.

## 1. 관련 코드 조사 결과

- **Daily Briefing**은 전적으로 클라이언트에서 만들어진다. `index.html`의 `generateBriefing()`이 `/api/search-news`로 기사 제목만 가져온 뒤, system 프롬프트를 JS에서 직접 문자열로 조립해서 **`/api/chat`**(범용 프록시, `server.js:302` — 클라이언트가 보낸 body를 검증 없이 그대로 Anthropic에 전달)로 호출한다. 모델은 `claude-haiku-4-5-20251001` 고정. 회사 관련 opportunity/risk는 `bizInstr`로 프롬프트에 지시만 할 뿐, 실제 웹 검색이나 공식 자료 조회는 전혀 없다.
- **Compare Companies**(`/api/compare-companies`, `server.js:324`)는 이미 서버 사이드다 — 사용자 뉴스 소스 + CourtListener(미국 연방법원) + SEC EDGAR(미국 증권거래위원회, `server.js:354`)를 모아 컨텍스트로 만들고 Haiku에 던진다. **CourtListener와 SEC EDGAR 둘 다 미국 전용**이라, 회사가 미국 밖에서 주로 사업하거나 미국 상장사가 아니면 이 두 소스가 사실상 무의미해진다 — 사용자가 지적한 문제의 정확한 원인.
- `/api/chat`는 클라이언트가 model/system/tools를 전부 통제하는 완전 개방형 프록시다. 여기에 비용이 많이 드는 web_search 툴 사용을 얹으면, 브라우저 개발자도구를 여는 누구나 무제한으로 웹 검색을 유발할 수 있다 — 이 프로젝트 CLAUDE.md에 이미 적어둔 원칙("서버가 프롬프트 고정, `/api/chat` 같은 범용 프록시는 비용이 드는 기능에 쓰지 않는다")과 정확히 충돌한다.
- `server.js`에 이미 `checkRateLimit(ip)` (5번째 줄 근처, 시간당 8회 고정, story-research 전용)가 있다 — 버킷을 나눠서 재사용 가능.
- claude-api 스킬 확인 결과: `web_search_20260209`/`web_fetch_20260209`(dynamic filtering 버전)는 Opus 4.8/4.7/4.6, Sonnet 5, Sonnet 4.6에서만 지원되고, 베타 헤더 불필요. `max_uses`, `allowed_domains`/`blocked_domains` 파라미터로 검색 횟수·도메인을 제어 가능.

## 2. 범위

### 2-1. Daily Briefing을 서버 사이드 엔드포인트로 이전
- 새 엔드포인트 `POST /api/generate-briefing` 추가. `generateBriefing()`이 조립하던 system 프롬프트 구성 로직을 서버로 옮긴다. 클라이언트는 여전히 `/api/search-news`로 기사를 먼저 가져온 뒤, `{topics, keywords, sectors, companies, articles, failedSources}`를 이 새 엔드포인트에 POST한다.
- 기존 `/api/chat` 자체는 삭제하지 않는다(다른 기능이 아직 쓰고 있을 수 있음 — Trend Analysis도 `/api/chat`을 직접 호출하는 걸 확인함, 그건 그대로 둔다). 다만 Daily Briefing만 전용 엔드포인트로 옮겨서 프롬프트·모델·툴을 서버가 고정하게 만든다.

### 2-2. 두 엔드포인트에 web_search + web_fetch 서버 툴 추가
- `/api/generate-briefing`, `/api/compare-companies` 둘 다 `tools: [{type:"web_search_20260209", name:"web_search", max_uses:8}, {type:"web_fetch_20260209", name:"web_fetch", max_uses:8}]` 추가. `max_uses`로 요청 한 번당 실제 검색·조회 횟수를 제한해서 비용을 예측 가능하게 만든다. 회사 2~4개 × 각각 다른 관할 조사가 겹치면 8회도 빠듯할 수 있어서, 구현 후 실제 사용량을 보고 조정 가능한 시작값으로 잡음(하드 고정값 아님).
- Compare Companies는 회사가 2개 이상일 때만 호출되니 자동으로 조건부. Daily Briefing 쪽은 **추적 기업(`S.companies`)이 1개 이상 설정된 경우에만** 회사 관련 웹 검색을 수행하도록 프롬프트에서 조건을 건다 — 추적 기업이 없으면 지금처럼 뉴스 소스 기반 요약만 하고 웹 검색은 쓰지 않아서 불필요한 비용을 막는다.

### 2-3. 새 system 프롬프트 — 글로벌 공식 소스 + 투자자 공개자료 대조
두 엔드포인트 공통으로 다음 지시를 프롬프트에 명시한다(초안, 실제 문구는 구현 시 다듬음):
1. **관할 파악 먼저**: 분석 대상 회사가 어느 국가에서 주로 사업하는지, 어디에 상장돼 있는지부터 파악(필요하면 web_search로 확인)하라.
2. **국가별 공식 소스 우선**: 파악된 국가에 맞는 공식·1차 자료를 우선 검색하라 — 예시로 미국은 SEC EDGAR·CourtListener, EU는 EUR-Lex·유럽위원회 발표, 영국은 Companies House·FCA, 일본은 EDINET, 한국은 DART 같은 곳을 참고 시작점으로 제시하되, 이 목록에 없는 국가도 회사에 맞게 알아서 적절한 공식 규제기관·법원 기록·정부 관보를 찾도록 지시한다. 블로그·SEO성 콘텐츠·근거 없는 추측성 뉴스보다 정부·법원·거래소·공식 규제기관 발표를 우선하라고 명시.
3. **투자자 공개자료 대조**: 회사가 최근 투자자에게 공개한 내용(10-K의 risk factors, 연차보고서, 실적발표 자료, 투자자 설명회 자료)을 찾아서, 지금 벌어지는 법률·규제 변화와 직접 대조하라 — 구체적으로 어디서 괴리나 리스크·기회가 생기는지 짚으라고 지시.
4. **근거 없는 일반론 금지**: 모든 risk/opportunity 항목은 반드시 구체적 출처(기사, 공시, 판례, 투자자 자료)를 근거로 삼아야 하고, 근거 없이 뭉뚱그린 일반적 서술은 금지한다고 명시.

### 2-4. 응답 스키마에 출처(citations) 추가 + 화면에 노출
- Compare Companies의 회사별 JSON에 `"citations": ["url1", "url2", ...]` 필드 추가, `renderCompareResults()`에 각 회사 카드 하단 "Sources" 섹션으로 클릭 가능한 링크 렌더링.
- Daily Briefing의 `biz` 배열 항목에도 `source` 필드를 추가해서(기존 bullet들이 이미 쓰는 `source` 링크 패턴과 동일하게) 근거 링크를 달 수 있게 한다.
- 이건 "정확하고 공신력 있는 정보"라는 요청을 실제로 검증 가능하게 만드는 핵심 장치라서 범위에 포함 — 사용자가 직접 클릭해서 원문을 확인할 수 있어야 "투자 판단에 참고할 만한 퀄리티"가 실제로 성립한다.

### 2-5. Rate limit 버킷 분리
기존 `checkRateLimit(ip)`를 `checkRateLimit(ip, bucket, max)`로 확장(버킷별 독립 카운터):
- `story-research`: 시간당 8회 (기존 유지)
- `compare-companies`: 시간당 10회 (신규)
- `generate-briefing`: 시간당 30회 (신규, Daily Briefing은 하루에도 여러 번 새로고침하는 핵심 기능이라 훨씬 여유 있게)

## 3. 작업 순서

1. `server.js`: `checkRateLimit`을 버킷 파라미터를 받도록 리팩터, story-research 호출부 갱신.
2. `server.js`: `/api/generate-briefing` 신설 — system 프롬프트 서버 이전, Sonnet 5 + web_search/web_fetch 툴 추가, rate limit 적용.
3. `server.js`: `/api/compare-companies`를 Sonnet 5 + web_search/web_fetch 툴로 업그레이드, 프롬프트에 §2-3 지시 추가, 응답 스키마에 `citations` 추가, rate limit 적용. 기존 SEC EDGAR/CourtListener 호출은 그대로 유지(미국 회사에는 여전히 유용하고 빠르고 무료).
4. `index.html`: `generateBriefing()`을 단순화 — 프롬프트 조립 로직 제거, `/api/generate-briefing` 호출로 교체. 기존 `foreignSummaries`/`sourceAlternatives` 등 기존 기능은 서버 프롬프트에 그대로 이전해서 동작 유지.
5. `index.html`: `renderCompareResults()`에 회사별 Sources 섹션 렌더링 추가. Daily Briefing bullet 렌더링에 biz 항목 source 링크 추가.
6. 로컬 검증(§5).

## 4. 기존 동작에 미치는 영향

- `/api/chat`은 삭제하지 않으므로 Trend Analysis 등 다른 기능은 영향 없음.
- Daily Briefing의 기존 기능(`foreignSummaries` 비영어 소스 요약, `sourceAlternatives` 실패한 소스 대안 제안, bullet의 `ref` 기반 원문 링크)은 전부 새 서버 프롬프트에 동일하게 포함시켜서 회귀 없게 한다.
- 추적 기업이 없는 사용자는 Daily Briefing에서 web_search를 전혀 안 쓰므로 비용·응답 시간 변화가 없다.
- Compare Companies를 쓰는 기존 사용자는 응답 시간이 늘어난다(웹 검색이 추가되니) — 로딩 스피너 문구는 이미 있어서 별도 UI 변경 불필요.

## 5. 테스트 plan

- 로컬에서 추적 기업 2개 이상 설정 후 Compare Companies 실행 — 응답에 미국 외 소스(설정에 따라 다르지만 최소한 US 외 지역 회사 선택 시)가 포함되는지, `citations` 필드가 채워지는지, 화면에 링크가 렌더링되는지 확인.
- 추적 기업 1개(또는 0개) 상태에서 Daily Briefing 생성 — 기존과 동일하게 동작하는지(회귀), web_search가 실제로 호출 안 되는지 확인.
- 추적 기업 여러 개 상태에서 Daily Briefing 생성 — biz 항목에 source가 달리는지 확인.
- 두 엔드포인트 다 rate limit이 지정한 버킷별 한도에서 정확히 429를 반환하는지 확인(story-research 버킷과 독립적으로 동작하는지도 확인).
- 로컬에 `ANTHROPIC_API_KEY`가 없어서 실제 웹 검색 호출 자체는 로컬에서 끝까지 검증 못 함 — 배포 후 실제 키로 한 번 실행해보는 게 필요하다고 안내.

## 6. 위험 / 엣지케이스

- **비용**: Sonnet 5 + web_search/web_fetch 조합은 요청 하나당 검색·조회로 유입되는 토큰이 많아서, `max_uses:6` 상한을 걸어도 Haiku 단독 대비 요청당 비용이 체감상 꽤 늘 수 있다(대략 요청당 5~20센트 수준으로 추정 — 실제로는 검색 히트 수·페이지 길이에 따라 편차가 큼). rate limit 버킷(compare 10/hr, briefing 30/hr)이 1차 방어선.
- **검색 품질 편차**: 국가마다 공식 소스의 영어/현지어 여부, 검색 노출도가 달라서 일부 국가는 여전히 결과가 부실할 수 있다 — 프롬프트에 "확실한 공식 출처를 못 찾으면 억지로 지어내지 말고 그렇게 명시하라"는 지시를 넣어서 환각을 줄인다.
- **응답 시간 증가**: 웹 검색이 여러 번 도는 만큼 사용자 체감 대기시간이 늘어난다 — 기존 로딩 스피너/문구 재사용으로 충분하다고 판단(새 UI 불필요).

## 7. Self-review

- **베스트인지**: 국가별 공식 API를 하나하나 직접 연동하는 대신 Claude의 web_search/web_fetch로 위임하는 방식이 유지보수 부담을 크게 줄인다 — 새 국가가 필요할 때마다 코드를 추가할 필요 없이 프롬프트 지시만으로 확장된다.
- **빠진 거 없는지**: 사용자가 요청한 세 가지 — 글로벌 공식 소스 활용, 투자자 공개자료 대조, 근거 있는 opportunity/risk — 를 모두 프롬프트 설계와 스키마(citations 필드)에 반영했다. `/api/chat`의 보안 원칙과 충돌하는 부분을 미리 잡아서 전용 엔드포인트로 옮기는 것도 포함했다. 검증 중 이 `citations` 필드가 기존에 이미 있던 최상위 `sources`(뉴스·판례·SEC 집계용) 객체와 이름이 겹칠 뻔한 걸 잡아서 이름을 바꿨다.
- **오버한 거 없는지**: 앱 전체를 Sonnet으로 올리지 않고 이 두 기능에만 한정했다. 국가별 공식 API를 전부 직접 붙이는(더 정확할 수 있지만 유지보수 부담이 훨씬 큰) 방식은 선택하지 않았다.
