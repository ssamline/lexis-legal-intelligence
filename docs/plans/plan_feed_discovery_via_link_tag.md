# Plan — 하드코딩된 RSS 경로 추측 대신 사이트가 광고하는 실제 피드 주소 탐색

상태: 사용자와 논의로 방향 확정, 인터뷰 불필요, 구현 대기.

## 1. 배경 — 왜 이 방향인가

사용자의 진짜 목적은 "누구나 자유롭게 기사 소스를 등록하고, 거기서
Legal Topics/Business Sectors 기준으로 정보를 받는 것"이다. 지금 구조
(`server.js:9-14`의 `RSS_PATHS` 15개 경로를 순서대로 찍어보는 방식)는
이 목적에 두 가지로 부족하다는 걸 실측으로 확인했다.

- `courthousenews.com`은 실제로 RSS가 살아있다(`/feed/`가 200) — 그런데
  우리 목록엔 슬래시 없는 `/feed`만 있어서 못 찾았고, 슬래시 없는 경로는
  이 사이트에서 403(봇 차단)으로 막혔다. 즉 "RSS가 없어서"가 아니라
  "우리가 찍어본 경로가 그 사이트의 실제 경로와 안 맞아서" 실패한
  케이스였다.
- `law360.com`은 홈페이지 어디에도 `<link rel="alternate"
  type="application/rss+xml">` 태그가 없다 — 이건 정말로 공개 RSS를
  안 낸다는 뜻이라(구독형 매체), 어떤 경로를 더 추가해도 못 찾는다.

사이트 대부분(특히 워드프레스 기반 뉴스·블로그, 실사용자가 등록할 법한
사이트 다수)은 자기 홈페이지 `<head>`에 `<link rel="alternate"
type="application/rss+xml" href="...">` 태그로 진짜 피드 주소를 표준
방식으로 광고한다. 이걸 직접 읽으면 경로를 계속 추측·하드코딩하지
않고도 그 사이트의 진짜 피드를 찾을 수 있다 — 새 유료 API나 헤드리스
브라우저 없이, 지금 있는 `fetch()`만으로 가능하다.

## 2. 관련 코드 파악

`server.js:47-76`의 `fetchSiteArticles(domain)`이 핵심이다. 지금은
`RSS_PATHS` 배열을 순서대로 `base + feedPath`에 요청해서, 응답이
`ok`이고 content-type이 XML스럽고 `<item>`/`<entry>`가 있으면 그걸
파싱해서 반환하고, 첫 성공에서 멈춘다. 전부 실패하면 빈 배열을 반환한다
(`/api/search-news`, `server.js:83-94`가 이 함수를 도메인별로 병렬
호출해서 합친다).

`parseXmlItems(xml, sourceDomain, maxItems)`(`server.js:23-45`)는 이미
RSS `<item>`과 Atom `<entry>` 둘 다 지원하는 범용 파서라 — 새로
탐색한 피드 URL의 응답도 그대로 재사용 가능하다(수정 불필요).

## 3. 구현

### 3-1. 피드 탐색 fetch/parse 로직을 헬퍼로 분리

`fetchSiteArticles` 안의 "한 URL에 요청해서 파싱까지" 로직(지금
`server.js:53-72`의 for 루프 본문)을 재사용 가능한 함수로 뺀다 —
아래 3-3에서 "탐색된 URL 1개 시도"와 "기존 경로 목록 순회" 둘 다 같은
로직을 쓰기 때문이다.

```js
async function tryFetchFeed(url, domain) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LexBrief/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
      },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow'
    });
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('html') && !ct.includes('xml')) return [];
    const xml = await res.text();
    if (!xml.includes('<item>') && !xml.includes('<entry>')) return [];
    return parseXmlItems(xml, domain, 8);
  } catch {
    return [];
  }
}
```

### 3-2. 홈페이지에서 `<link rel="alternate">` 태그 탐색

`server.js:47` 근처(`fetchSiteArticles` 앞)에 추가.

```js
function findFeedLinkInHtml(html) {
  const linkTags = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const candidates = linkTags.filter(tag =>
    /rel=["']?alternate["']?/i.test(tag) &&
    /type=["']?application\/(?:rss|atom)\+xml["']?/i.test(tag)
  );
  // WordPress (very common among small news/blog sites) emits a "Comments
  // Feed" <link> alongside the real article feed — usually after it, but
  // that order isn't guaranteed. Skip anything whose title says "comment"
  // so we don't silently parse blog comments instead of articles.
  const primary = candidates.find(tag => !/title=["'][^"']*comment/i.test(tag)) || candidates[0];
  if (!primary) return null;
  const hrefMatch = primary.match(/href=["']([^"']+)["']/i) || primary.match(/href=([^\s>]+)/i);
  return hrefMatch ? decodeEntities(hrefMatch[1]) : null;
}

async function discoverFeedUrl(base) {
  try {
    const res = await fetch(base + '/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow'
    });
    if (!res.ok) return null;
    const html = await res.text();
    const href = findFeedLinkInHtml(html);
    return href ? new URL(href, base + '/').href : null;
  } catch {
    return null;
  }
}
```

`<link>` 태그를 속성 순서·따옴표 유무와 무관하게 잡기 위해 태그 전체를
먼저 뽑아서 `rel=alternate`와 `type=application/(rss|atom)+xml`이 둘 다
있는지 따로 검사한다 — 실제로 `courthousenews.com`은
`<link rel=alternate type=application/rss+xml ... href=https://...>`
처럼 따옴표 없이 내려주는데, 이 방식이면 그대로 잡힌다(직접 확인함).
상대경로 href(`/feed`)와 절대경로 href(`https://...`) 둘 다 안전하게
처리하려고 문자열 조합 대신 내장 `URL` 생성자를 쓴다(Node 전역, 새
의존성 아님) — 프로토콜 상대경로(`//cdn.example.com/feed`)까지 자동으로
처리된다.

**plan-verify에서 잡은 수정 사항** — 워드프레스는 본문 피드 `<link>`
바로 옆에 "Comments Feed"용 `<link>`도 같이 내보낸다(실제로
`courthousenews.com`에서 두 개 다 확인했다 — "Feed"와 "Comments
Feed"). 처음 작성한 코드는 그냥 첫 번째 매칭 태그를 썼는데, 태그
순서가 항상 본문 피드가 먼저라는 보장이 없어서, `title` 속성에
"comment"가 들어간 태그는 건너뛰고 그다음 후보를 쓰도록 `candidates`
배열 + `find()`로 바꿨다 — 순서에 안 흔들리게 만든 것이다. 이걸 놓쳤으면
댓글 피드가 조용히 파싱돼서 법률·비즈니스 기사 대신 블로그 댓글이
브리핑에 섞여 들어가는, 겉으로는 "성공"처럼 보이지만 내용이 완전히
엉뚱한 조용한 실패가 났을 것이다.

브라우저와 똑같은 User-Agent로 홈페이지를 요청하는 이유는, 일부
사이트가 낯선 봇 UA에는 홈페이지 자체를 다르게(또는 차단해서) 내려주기
때문이다 — 실제로 `courthousenews.com` 홈페이지를 브라우저 UA로
요청했을 때만 `<link>` 태그가 포함된 정상 HTML을 받았다. 피드 URL 자체를
요청할 때는(3-1) 기존 `LexBrief/1.0` UA를 그대로 쓴다 — 정확한 정식
경로(`/feed/`)로 요청하면 어느 UA로도 200이 오는 걸 이미 확인했다.

### 3-3. `fetchSiteArticles`를 "탐색 우선, 경로 추측은 폴백"으로 재구성

`server.js:47-76`을 아래로 교체한다.

```js
async function fetchSiteArticles(domain) {
  const base = /^https?:\/\//.test(domain)
    ? domain.replace(/\/$/, '')
    : `https://${domain}`;

  // 1. Ask the site what feed it actually advertises — works for any
  //    domain that follows the standard, regardless of path convention.
  const discovered = await discoverFeedUrl(base);
  if (discovered) {
    const items = await tryFetchFeed(discovered, domain);
    if (items.length) {
      console.log(`[RSS] ${domain} via discovered link (${discovered}) → ${items.length} articles`);
      return items;
    }
  }

  // 2. Fall back to guessing common paths — still catches sites that
  //    don't advertise a <link> tag but do have a feed at a known path.
  for (const feedPath of RSS_PATHS) {
    const items = await tryFetchFeed(base + feedPath, domain);
    if (items.length) {
      console.log(`[RSS] ${domain}${feedPath} → ${items.length} articles`);
      return items;
    }
  }

  console.warn(`[RSS] No feed found for ${domain}`);
  return [];
}
```

기존 하드코딩 목록(`RSS_PATHS`)은 그대로 둔다 — `<link>` 태그를 안
광고하지만(예: `legaltimes.co.kr`, 확인함 — 태그 없음) 경로 자체는
목록에 있는 사이트를 계속 커버해야 하기 때문이다. 이번 변경은 기존
경로를 대체하는 게 아니라 그 앞에 더 신뢰할 수 있는 탐색 단계를
끼워 넣는 것이다.

## 4. 테스트 plan

- `courthousenews.com` — 로컬에서 `/api/search-news`에
  `{"urls":["courthousenews.com"]}`로 직접 요청해서, 이번엔 실제로
  기사가 반환되는지 확인(지금은 0개). 서버 로그에
  `[RSS] courthousenews.com via discovered link (...) → N articles`가
  찍히는지도 확인. 이 사이트는 "Feed"와 "Comments Feed" 두 `<link>`가
  같이 있는 실제 케이스라, 로그에 찍힌 discovered URL이
  `/comments/feed/`가 아니라 `/feed/`(본문 피드)인지, 반환된 기사
  제목들이 실제 법률/비즈니스 뉴스이지 댓글 텍스트가 아닌지 확인한다 —
  plan-verify에서 잡은 title 필터링이 실제로 동작하는지 보는 핵심
  테스트다.
- `law360.com` — 여전히 빈 배열이 반환되는지(회귀 아님 — 애초에 RSS가
  없는 사이트라 탐색해도 못 찾는 게 맞는 동작), 에러 없이 조용히
  실패하는지.
- `legaltimes.co.kr` — `<link>` 태그가 없는 사이트라 1단계는 실패하고
  2단계(기존 경로 목록의 `/rss/allArticle.xml`)로 여전히 잘 잡히는지
  (회귀 확인 — 어제 이 사이트를 위해 추가한 경로가 계속 동작해야 함).
- 세 소스를 한 번에 등록한 상태로 Daily Briefing을 Renew 해서, 이번엔
  영어(courthousenews)와 한국어(legaltimes) 기사가 실제로 섞여서
  들어오는지, 그 상태에서 지난 plan(콘텐츠 선정 기준)에서 추가한 "전략적
  중요도 우선" 지시가 실제로 양쪽 소스를 topic 관련성 기준으로 고르게
  다루는지 확인.
- 아무 피드도 없고 `<link>` 태그도 없는 임의 사이트(예: 순수 정적
  랜딩페이지)를 하나 추가해봐서, 무한 대기나 에러 없이 빈 배열로 조용히
  넘어가는지(기존 동작 유지) 확인.
- 홈페이지 자체가 안 열리는 도메인(오타·존재하지 않는 도메인)을 넣었을
  때도 `discoverFeedUrl`의 catch가 안전하게 null을 반환하고 2단계로
  넘어가는지.

## 5. 리스크 / 엣지케이스

도메인 하나당 요청 수가 최악의 경우 기존 대비 1개 늘어난다(홈페이지
탐색 1회 + 기존 경로 목록 최대 16개) — 다만 탐색이 성공하는 사이트는
대부분 첫 시도에서 끝나므로 오히려 평균적으로는 더 빨라진다(기존엔
맞는 경로를 찾을 때까지 목록을 순서대로 다 시도해야 했다).

`<link>` 태그 탐색이 성공했는데 정작 그 URL 자체가 막혀 있거나(예:
피드는 광고하지만 접근은 차단하는 사이트) 빈 피드인 경우, 조용히
2단계(기존 경로 목록)로 넘어간다 — 이미 그렇게 설계했다.

여전히 `law360.com`처럼 RSS를 아예 안 내는 사이트는 이번 변경으로도
못 잡는다 — 이건 이번 plan이 풀려는 문제가 아니다(1번에서 이미 분리해
둔 범위). 사용자가 등록한 소스가 매번 조용히 실패하는 경우 UI에서
알려주는 기능(예: "이 소스는 기사를 못 가져왔어요" 배지)은 아직 없다 —
이번 요청은 "더 많은 사이트가 실제로 동작하게" 만드는 것이었지 "실패를
사용자에게 보여주는" 것은 아니어서 범위에서 뺐다. 필요하시면 후속
작업으로 쉽게 추가 가능하다(예: `/api/search-news` 응답에 도메인별
성공/실패 상태를 같이 실어서 Sources & Topics 화면에 표시).

## 6. Self-review

**베스트 plan인지** — 새 유료 API, 헤드리스 브라우저, 새 npm 의존성
없이 표준 HTML 태그를 읽는 것만으로 courthousenews.com 같은 사이트
다수를 즉시 해결한다. 기존 경로 추측 목록은 폴백으로 그대로 살려서
하위 호환도 유지한다.

**빠진 게 있는지** — `legaltimes.co.kr`이 `<link>` 태그를 안 쓰는
사이트라는 걸 직접 확인해서, 이번 변경이 기존에 겨우 잡아둔 소스를
깨지 않는다는 걸 검증했다. `law360.com`처럼 진짜 RSS가 없는 사이트는
이 방식으로도 못 푼다는 한계를 투명하게 남겼다. plan-verify 과정에서
워드프레스 사이트가 본문 피드와 댓글 피드 `<link>`를 같이 내보낸다는
걸 재확인해서, 처음 작성한 "첫 번째 매칭 태그 사용" 로직이 순서가
안 맞으면 댓글 피드를 조용히 잘못 파싱할 수 있는 결함이었다는 걸
찾아 title 필터링으로 고쳤다 — 겉보기엔 "성공"으로 보이지만 내용이
완전히 엉뚱한, 발견하기 어려운 종류의 버그였을 것이다.

**오버한 게 있는지** — 완전히 RSS가 없는 사이트를 위한 홈페이지
스크래핑 폴백(기사 링크를 휴리스틱으로 추측)이나, 실패한 소스를 UI에
표시하는 기능 모두 이번 범위에 넣지 않았다 — 지금 확인된 문제(경로
추측 방식의 한계)만 정확히 고치는 선에서 멈췄다.

**테스트 충분한지** — 이번에 문제였던 courthousenews, 원래 안 되는
law360, 어제 고친 legaltimes 세 곳을 각각 다른 이유로 커버했고, 임의
사이트·존재하지 않는 도메인 같은 엣지케이스도 포함했다. plan-verify에서
잡은 댓글 피드 오탐 케이스도 courthousenews.com이 실제로 그 두 태그를
같이 갖고 있어서 별도 목업 없이 같은 테스트로 검증 가능하다.

## 7. 사용자 결정 필요 항목

없음 — 방향 자체를 사용자와 대화로 이미 확정했다.
