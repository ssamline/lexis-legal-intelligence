# Plan — 기본 소스 교체 + 소스 실패 시 알림·대체 사이트 추천

상태: 설계 완료, 인터뷰 불필요(사용자가 선택을 위임), 구현 대기.

## 1. 요청 요약

두 가지다.

- 기본 소스(`S.urls` 기본값, 지금 `['law360.com','courthousenews.com']`)에서
  `law360.com`을 빼고, 직접 검증해서 실제로 기사가 잡히는 곳들 중
  베스트 5개로 교체한다(로그인한 닉네임과 무관하게 신규 사용자가 받는
  기본값).
- Daily Briefing을 Renew할 때, 사용자가 추가한 소스 중 그날 기사를
  하나도 못 가져온 곳이 있으면 화면에 알려주고, 비슷한 대체 사이트를
  추천한다.

## 2. 기본 소스 5개 선정 (직접 검증 완료)

로컬 서버로 우리 앱의 실제 피드 탐색 로직에 10개 후보를 태워서
검증했다 — `abovethelaw.com`, `abajournal.com`, `jurist.org`,
`lawgazette.co.uk`, `legalcheek.com`, `natlawreview.com`,
`scotusblog.com`, `complianceweek.com` 8개가 실제로 기사를 반환했고,
`jdsupra.com`/`law.com`/`reuters.com`/`federalregister.gov`/
`lexology.com`은 안 됐다(RSS 미공개 또는 JS 렌더링 구조).

이 중 베스트 5개를 다음 기준으로 골랐다 — 법률·규제 업데이트 위주(사용자
요청의 핵심), 미국/영국 커버리지, 비즈니스 영향 판단에 쓸모 있는 소스.

- `natlawreview.com` — 로펌들이 직접 쓰는 규제·컴플라이언스 분석 글
  모음. "법령 업데이트"에 가장 정확히 들어맞는다.
- `complianceweek.com` — 규제·컴플라이언스 전문지.
- `abajournal.com` — 미국변호사협회(ABA) 공식 저널, 권위 있고 폭넓은
  법률 뉴스.
- `courthousenews.com` — 이번에 피드 탐색 수정으로 되살아난 소스,
  광범위한 소송·법원 뉴스. 기존 기본값 중 하나였고 이제 실제로
  동작하니 그대로 남긴다.
- `lawgazette.co.uk` — 영국 법률협회(Law Society) 공식 매체, 영국
  커버리지 확보.

`abovethelaw.com`/`legalcheek.com`(업계 문화·가십 성격이 더 강함),
`jurist.org`/`scotusblog.com`(각각 국제뉴스·연방대법원 특화라 범위가
좁음)은 이번 5개에서 뺐다 — 사용자가 원하면 Sources & Topics에서 언제든
직접 추가 가능하다(이 기능은 그대로 유지).

## 3. 구현 A — 기본 소스 교체

`index.html:613`의 `S.urls` 기본값을 교체한다.

```js
urls: ['natlawreview.com','complianceweek.com','abajournal.com','courthousenews.com','lawgazette.co.uk'],
```

이 값은 `S` 객체 리터럴의 초기값이라 로그인 여부·닉네임과 무관하게
모든 신규 방문자에게 적용된다 — 이미 특정 닉네임으로 소스를 커스터마이즈해
Firestore에 저장해 둔 기존 사용자는 `loadUserProfile()`이 그 값을
그대로 불러오므로 영향받지 않는다(요청하신 "로그인을 누가 하든 관련없이
기본값"이 정확히 이 의미 — 처음 쓰는 신규 닉네임에게 적용되는 출발점
값이라는 뜻이지, 기존 사용자 설정을 덮어쓴다는 뜻이 아니다).

같은 `S` 객체 리터럴(`index.html:608-619`)에 `failedSources: []` 필드도
같이 선언해 둔다 — 4-2에서 `generateBriefing()` 안에서 동적으로
`S.failedSources = ...`를 대입해도 JS 문법상 문제는 없지만, 이 객체의
다른 모든 필드(`urls`/`topics`/`archive`/`articles` 등)가 전부 상단에
미리 선언돼 있는 기존 스타일과 맞추기 위해 여기서도 미리 선언해 둔다.

## 4. 구현 B — 소스 실패 알림 + 대체 사이트 추천

### 4-1. 서버 — 도메인별 성공/실패를 응답에 포함

`server.js:138-149`의 `/api/search-news` 핸들러를 아래로 교체한다.
`fetchSiteArticles(domain)`가 실패 시 빈 배열을 반환하는 걸 그대로
이용해서, 어느 도메인이 0개였는지 계산해 응답에 같이 실어 보낸다.

```js
app.post('/api/search-news', async (req, res) => {
  const { urls = [] } = req.body;
  if (!urls.length) return res.json({ articles: [], failedDomains: [] });

  try {
    const results = await Promise.all(urls.map(domain => fetchSiteArticles(domain)));
    const articles = results.flat();
    const failedDomains = urls.filter((_, i) => results[i].length === 0);
    res.json({ articles, failedDomains });
  } catch (e) {
    res.json({ articles: [], failedDomains: urls });
  }
});
```

### 4-2. 클라이언트 — 실패 도메인 기록

`index.html:932-946`(`generateBriefing()`의 기사 fetch 블록)을 아래로
교체한다.

```js
// Fetch articles directly from user's chosen source websites
S.articles = [];
S.failedSources = [];
let articleCtx = '';
try {
  const newsRes  = await fetch('/api/search-news', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: S.urls })
  });
  const newsData = await newsRes.json();
  S.articles      = newsData.articles || [];
  S.failedSources = newsData.failedDomains || [];
  if (S.articles.length) {
    articleCtx = '\n\nRecent articles fetched from the user\'s selected sources:\n' +
      S.articles.map((a, i) => `${i+1}. (${a.domain}) ${a.title}`).join('\n');
  }
} catch(e) { /* proceed without real articles */ }
```

### 4-3. 프롬프트에 대체 사이트 추천 지시 추가

기존 `/api/chat` 호출 하나에 지시만 더 얹는다 — 별도 API 호출이나
서버 엔드포인트를 새로 만들지 않는다(이 앱의 기존 방식과 일관).
`index.html:948-954` 근처에 추가.

```js
const failedSourcesInstr = S.failedSources.length
  ? ` Additionally, for each of these source domains that returned no articles today — ${S.failedSources.join(', ')} — suggest ONE real, well-known alternative English-language legal or business-regulatory news site (one likely to have a working public RSS feed) that covers similar ground. Add one entry per failed domain to a "sourceAlternatives" array: {"failedDomain":"...","suggestion":"suggested-domain.com","reason":"one short sentence why"}.`
  : '';
```

`system` 템플릿의 `hasArticles ? ... : ...` 삼항 뒤에 이어 붙인다(어느
분기를 타든 실패 도메인 안내는 독립적으로 필요하므로 두 분기 바깥에
둔다).

```js
const system = `You are a senior legal news analyst. Generate a concise daily legal briefing for ${today}. Topics: ${topicNames}.${kwExtra}${bizInstr}
${hasArticles ? articleCtx + `\n\nUsing ONLY the articles listed above, ...${foreignInstr}` : 'No live articles available — generate a plausible briefing based on current legal trends. Omit "ref" from bullets.'}${failedSourcesInstr}
Reply ONLY in valid JSON, no markdown fences:
{"sections":[...],"foreignSummaries":[...],"sourceAlternatives":[{"failedDomain":"...","suggestion":"...","reason":"..."}]}
Only include these topics: ${activeTopics.join(',')}.`;
```

`S.failedSources.length`가 0이면 `failedSourcesInstr`가 빈 문자열이라
프롬프트에 아무것도 안 붙는다 — 실패한 소스가 없는 보통의 경우엔 토큰
낭비도, AI가 괜히 뭔가 지어낼 여지도 없다.

### 4-4. 응답 파싱 + 배너 렌더링

`index.html:1000` 근처(`foreignSummaries` 파싱 다음 줄)에 추가.

```js
const sourceAlternatives = Array.isArray(parsed.sourceAlternatives) ? parsed.sourceAlternatives : [];

const warnEl = document.getElementById('source-warning');
if (S.failedSources.length) {
  const lines = S.failedSources.map(domain => {
    const alt    = sourceAlternatives.find(a => a.failedDomain === domain);
    const line   = alt ? t('brief.source_failed_try', {domain, suggestion: alt.suggestion}) : domain;
    const reason = alt?.reason ? ` — ${alt.reason}` : '';
    return `${line}${reason}`;
  }).join('<br>');
  warnEl.innerHTML = `⚠️ <span><strong>${t('brief.source_failed_title')}</strong><br>${lines}</span>`;
  warnEl.style.display = 'flex';
} else {
  warnEl.style.display = 'none';
}
```

**plan-verify에서 잡은 수정 사항** — 처음 작성한 코드는 `<strong>` 뒤에
`<div>`를 여러 개 이어붙였는데, `.note` 클래스가
`display:flex;gap:8px;align-items:flex-start`라서(`index.html:155`)
직계 자식 `<div>` 각각이 별도 flex item이 되어 세로로 쌓이지 않고
가로로 어긋나게 배치되는 실제 레이아웃 버그였다. 기존 `.note` 사용
두 곳(`personal.qa_note`/`personal.compare_note`, 각각
`index.html:461`/`477`)이 전부 "이모지 텍스트 노드 + `<span>` 하나"
두 개의 flex item만 쓰는 패턴이라, 그 구조를 그대로 따라서 이모지 뒤에
`<span>` 하나로 감싸고 그 안에서 `<br>`로 줄바꿈하도록 고쳤다 — flex
item은 항상 정확히 2개(이모지, span)로 유지된다. `warnEl.style.display`도
`'block'`이 아니라 `.note`의 원래 `display:flex`를 살리는 `'flex'`로
맞췄다(`'block'`으로 두면 flex 레이아웃 자체가 깨진다).

`domain`/`suggestion`/`reason`을 HTML 이스케이프 없이 그대로
innerHTML에 꽂는 건, 같은 함수 안 다른 렌더링(불릿·prose·
foreignSummaries)이 이미 전부 그렇게 하고 있는 기존 관행과 일관되게
맞춘 것이다(오늘 오전 foreignSummaries 작업 때 같은 판단을 한 번 더
반복하는 것 — 이 함수 전체의 이스케이프 정책을 이번에 새로 설계하지
않는다).

배너는 AI 응답이 성공적으로 파싱된 경우에만 갱신된다 — `/api/chat`
자체가 실패하면(예: API 키 미설정) 이미 더 눈에 띄는
`brief-empty`/`brief-err-msg` 에러 화면이 뜨므로, 그 상태에서까지
소스 배너를 따로 챙기는 건 이번 범위에서 과하다고 판단했다(6번 참고).

### 4-5. HTML — 배너 엘리먼트 + 초기화

`index.html:366`(`#brief-empty`) 바로 위, `#brief-out` 바로 위에 추가.
기존 `.note` 클래스(질문/비교 화면에서 이미 쓰고 있는 안내 박스 스타일)를
그대로 재사용해서 새 색상·스타일을 따로 만들지 않는다.

```html
<div id="source-warning" class="note" style="display:none;margin-bottom:1rem"></div>
```

`generateBriefing()` 맨 앞, 기존 초기화 블록(`index.html:917-920`,
`brief-empty`/`brief-out`/`brief-spin`을 리셋하는 부분)에 한 줄 추가해서
이전 Renew의 배너가 이번 결과와 안 섞이게 한다.

```js
document.getElementById('brief-empty').style.display = 'none';
document.getElementById('brief-out').style.display   = 'none';
document.getElementById('source-warning').style.display = 'none';
document.getElementById('brief-spin').style.display  = 'inline-flex';
document.getElementById('renew-btn').disabled        = true;
```

### 4-6. i18n — 새 키 2개, 6개 언어

`I18N` 객체의 6개 언어 블록 각각에 `brief.foreign_summary_label` 옆에
추가한다. `{domain}`/`{suggestion}`은 AI가 다루는 값이 아니라 그대로
전달되는 도메인 문자열이라 어느 언어에서도 안 바뀐다.

| 언어 | `brief.source_failed_title` | `brief.source_failed_try` |
|---|---|---|
| en | Some sources didn't return articles today: | {domain} — try {suggestion} instead |
| ko | 오늘 일부 소스에서 기사를 못 가져왔어요: | {domain} — 대신 {suggestion} 시도해보세요 |
| es | Algunas fuentes no devolvieron artículos hoy: | {domain} — prueba con {suggestion} en su lugar |
| fr | Certaines sources n'ont renvoyé aucun article aujourd'hui : | {domain} — essayez {suggestion} à la place |
| zh | 今天部分来源没有返回文章： | {domain} — 请尝试改用 {suggestion} |
| ja | 本日、一部のソースから記事を取得できませんでした： | {domain} — 代わりに{suggestion}をお試しください |

## 5. 테스트 plan

- 새 브라우저(닉네임 등록 안 한 상태)로 처음 방문 시 Sources & Topics의
  기본 URL 목록이 `natlawreview.com`/`complianceweek.com`/
  `abajournal.com`/`courthousenews.com`/`lawgazette.co.uk` 5개로 뜨는지
  확인.
- 이미 커스텀 소스를 설정해 둔 기존 닉네임으로 로그인 시, 기본값 변경과
  무관하게 그 닉네임이 저장해 둔 소스 그대로 복원되는지(회귀 확인).
- Sources & Topics에 실제로 기사가 하나도 안 잡히는 도메인(예:
  `jdsupra.com`)을 하나 추가하고 Renew — 브리핑은 정상 생성되면서
  (다른 4개 소스가 살아있으므로), `#source-warning` 배너에
  "jdsupra.com — try [AI가 제안한 대체 사이트] instead"가 뜨는지 확인.
- 등록한 소스 전부가 실패하는 극단적 케이스(예: 존재하지 않는 도메인만
  등록) — `hasArticles`가 false라 "그럴듯한 브리핑" 분기를 타면서도,
  `failedSourcesInstr`는 별도로 붙어서 배너에 실패 소스 전부가 나열되고
  각각 대체 사이트가 제안되는지 확인.
- 실패 소스가 없는 정상 케이스(기본 5개 소스 그대로) — 배너가 아예 안
  뜨는지, 프롬프트에 불필요한 지시가 안 붙는지(네트워크 탭에서 요청
  바디 확인).
- 배너가 뜬 상태에서 다시 Renew(이번엔 실패 소스를 지워서) — 이전
  배너가 사라지는지(4-5의 리셋 로직 확인).
- UI 언어를 6개 다 돌려가며 배너 제목·문장이 정확히 번역되고
  `{domain}`/`{suggestion}` 자리는 그대로 남는지 확인.
- Archive에 저장된 과거 브리핑을 다시 열었을 때 이 배너가 안 뜨는지
  (배너는 그 순간의 진단 정보라 archive HTML에 안 들어가야 정상 — 저장
  로직(`entry.html = out.innerHTML`)이 `#source-warning`이 아니라
  `#brief-out`만 캡처하므로 자연히 그렇게 된다. 별도 코드 불필요).
- 실패 소스가 2개 이상인 상태로 배너를 띄워서, 각 줄이 가로로 어긋나지
  않고 세로로 깔끔하게 쌓이는지 육안으로 확인한다 — plan-verify에서
  `.note`의 `display:flex` 때문에 처음 설계(형제 `<div>` 여러 개)가
  레이아웃을 깨뜨렸을 거라는 걸 찾아 `<span>` 하나로 감싸는 구조로
  고쳤는데, 이게 실제로 의도대로 렌더링되는지 보는 핵심 회귀 테스트다.

## 6. 리스크 / 엣지케이스

`/api/chat` 호출 자체가 실패하면(API 키 미설정, 네트워크 오류 등)
소스 실패 배너도 같이 안 뜬다 — 이미 더 큰 에러 화면
(`brief-empty`/`brief-err-msg`)이 뜨는 상태라, 그 위에 소스 배너까지
별도로 챙기는 건 사용자에게 오히려 정보 과부하라고 판단해서 뺐다.
필요하면 `/api/search-news` 응답을 받은 직후(AI 호출 전) 배너를 먼저
한 번 채워두는 방식으로 후속 확장 가능하다.

AI가 제안하는 대체 사이트가 실제로 RSS를 지원하는지는 보장되지 않는다
— "잘 알려진 사이트"를 추천하라고만 지시했지, 서버가 그 추천 URL을
실시간으로 재검증하지는 않는다(재검증하려면 `/api/chat` 응답을 기다린
뒤 그 추천 도메인으로 `/api/search-news`를 한 번 더 호출해야 해서
지연이 커진다). 이번 범위에서는 "그럴듯한 제안"까지만 하고, 사용자가
그 추천을 직접 추가해보고 안 되면 또 배너가 뜨는 식으로 자연스럽게
드러나게 두는 쪽을 택했다.

## 7. Self-review

**베스트 plan인지** — 새 서버 엔드포인트나 별도 API 호출 없이, 이미
있는 `/api/search-news` 응답 확장 + 이미 있는 `/api/chat` 호출에
지시 추가만으로 두 요청을 다 만족시킨다. 기존 `.note` 스타일을
재사용해서 새 디자인 요소도 안 만들었다.

**빠진 게 있는지** — 기존 닉네임의 커스텀 소스가 기본값 변경에 영향
안 받는지, Archive에는 이 배너가 안 남는지 둘 다 코드 흐름으로
확인했다. 실패 소스가 하나도 없을 때 프롬프트에 불필요한 텍스트가
안 붙는다는 것도 명시했다. plan-verify 과정에서 `.note` 클래스가
`display:flex`라는 걸 CSS에서 직접 확인해서, 처음 설계한 여러 개의
형제 `<div>` 구조가 세로로 안 쌓이고 가로로 어긋나는 실제 레이아웃
버그였다는 걸 찾아 고쳤다 — 기존 `.note` 사용 두 곳의 마크업 패턴과
대조해보지 않았으면 구현하고 나서야 눈으로 보고 발견했을 결함이다.
`S` 객체 리터럴에 다른 필드들처럼 `failedSources`를 미리 선언해 두는
것도 이번에 챙겼다.

**오버한 게 있는지** — AI가 추천한 대체 사이트를 서버가 자동으로
재검증하는 것, 실패 배너에 "지금 바로 추가" 원클릭 버튼을 만드는 것
모두 이번 요청 범위를 넘어서는 확장이라 넣지 않았다. `/api/chat` 실패
시에도 배너를 따로 챙기는 것도 정보 과부하라고 판단해 뺐다.

**테스트 충분한지** — 기본값 교체 회귀, 부분 실패, 전체 실패, 실패 없음,
배너 리셋, 6개 언어, Archive 비영속성까지 포함했고, plan-verify에서
잡은 flex 레이아웃 버그를 확인하는 육안 테스트도 추가했다.

## 8. 사용자 결정 필요 항목

없음 — 기본 소스 5개 선정은 사용자가 이미 저에게 위임했다.
