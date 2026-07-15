# Spec — 사이트 개편: 내비게이션 재구성 + Archive 클라우드 동기화 + Trend 분석 + 다국어 지원

상태: 설계 완료(인터뷰 3건 반영), 구현 대기. 메이저 기능(내비게이션 구조
변경 + 새 Firestore 컬렉션 + AI 분석 기능 + 6개 언어 i18n)이라 `spec_`
문서로 영구 보존한다. 기존 `spec_firebase_thoughts.md`(친구 의견/질문
게시판 + 익명 인증)와 같은 Firebase 프로젝트(`legally-business`)를
그대로 재사용하고, 그 스펙에서 이미 검증된 패턴(모듈 스크립트 구조,
`escHtml`, `window.fn = fn` 노출 방식, Anonymous Auth)을 그대로 따른다.

## 0. 인터뷰 결정 사항 요약

구현 전에 사용자에게 확인받은 3가지 트레이드오프는 다음과 같이 확정됐다.

- **Trend 분석 실행 방식** — 수동 버튼 + "최근 N개 브리핑" 범위 설정.
  자동 실행이나 임계값 배지 방식은 채택하지 않는다. 즉 "숫자" 설정은
  분석 범위(최근 N개)를 의미하고, 자동 트리거용 임계값이 아니다.
- **Archive 저장 범위** — 닉네임 기준으로 Firestore에 동기화한다(기기
  간 이어보기 가능). Sources & Topics 설정과 같은 저장 방식을 쓴다.
- **다국어 지원 범위** — 고정 UI 텍스트(메뉴·버튼·라벨·안내 문구)만
  번역한다. Daily Briefing 본문이나 Sharing Thoughts 글/댓글 같은 AI
  생성·사용자 작성 콘텐츠는 번역하지 않고 원래 언어 그대로 보여준다.

## 1. 요청 요약

여섯 가지가 한 번에 요청됐다: (1) `Your Thoughts` 내비게이션 이름을
`Personal Tool`로 변경, (2) 그 안의 "내 생각"(Sharing) 서브탭을 빼서
`Personal Tool`과 `Sources & Topics` 사이에 독립된 최상위 탭
`Sharing Thoughts`로 만들기, (3) `Personal Tool` 안의 `Archive` 서브탭을
빼서 `Daily Briefing` 페이지 안에서 선택해 볼 수 있는 뷰로 옮기고
키워드로 검색·필터링하는 기능 추가, (4) Archive가 쌓일 때마다 사용자가
설정한 topic·범위 기준으로 trend 분석을 실행하는 기능, (5) 사이트
기본 언어를 영어로 하고 한국어/스페인어/프랑스어/중국어/일본어 UI 전환
기능 추가, (6) 닉네임으로 등록한 사용자의 Sources & Topics 설정이
다음 접속 때도(다른 기기 포함) 자동으로 복원되게 하기.

## 2. 현재 코드베이스 파악 결과

`index.html`(현재 1,810줄) 최상위 nav는 `nav-brief` / `nav-thoughts`
(label "Your Thoughts") / `nav-settings` 세 개이고, `showPanel()`
(`index.html:692`)이 `['brief','thoughts','settings']` 배열로 토글한다.
`panel-thoughts`(`index.html:346`) 안에 sub-nav 5개
(`sub-btn-mine`/`sub-btn-archive`/`sub-btn-search`/`sub-btn-qa`/
`sub-btn-compare`)가 있고 `showSubPanel()`(`index.html:992`)이
`['mine','archive','search','qa','compare']` 배열로 토글한다.

Archive는 지금 순수 `localStorage` 기반이다. `generateBriefing()`
(`index.html:801`)이 브리핑을 만들 때마다 `S.archive.unshift(entry)`
하고 `localStorage.setItem('lb_archive', ...)`로 저장하며 30개로
잘라낸다(`index.html:959-961`). `renderArchive()`(`index.html:1005`)가
`archive-cards`에 카드 목록을 그리고, `loadArchiveToQA()`
(`index.html:1034`)가 특정 항목을 Legal Q&A 컨텍스트로 로드하면서
`showSubPanel('qa', ...)`를 호출한다. Legal Q&A 안의 "Load from
archive" 버튼(`index.html:412`)은 반대로 `showSubPanel('archive', ...)`
를 호출한다 — 이 두 cross-link이 이번 개편의 핵심 연결점이라 반드시
같이 고쳐야 한다.

Sources & Topics 설정(`S.urls/topics/sectors/keywords/companies`)은
전부 `localStorage`의 `lexbrief_*` 키에 저장되고(`index.html:594-632`),
Firestore와는 전혀 연동돼 있지 않다. `S.archive`도 마찬가지로 순수
로컬 상태다.

`docs/plans/spec_firebase_thoughts.md`에서 이미 구현·검증된 Firebase
인프라는 다음과 같다 — CDN modular SDK(`firebase-app.js`,
`firebase-firestore.js`, `firebase-auth.js`, 버전 12.16.0), Anonymous
Auth로 얻는 `myUid`, 닉네임 게이트(`enterApp()`), `thoughts`/`comments`
컬렉션과 그 보안 규칙. 이번 기능은 같은 Firebase 프로젝트에 새 컬렉션
`users/{nickname}`(+ 서브컬렉션 `archive`)를 추가하는 형태로 확장한다.

## 3. 내비게이션 재구성 (1)+(2)+(3)

### 3-1. 최상위 nav

`nav-thoughts` 버튼의 표시 텍스트만 "💬 Your Thoughts" → "🛠 Personal
Tool"로 바꾼다(id는 `nav-thoughts`/`panel-thoughts`로 그대로 둔다 —
`goToCompare()`(`index.html:1062`) 등 기존 참조가 이 id에 묶여 있어서,
id까지 바꾸면 불필요한 연쇄 수정이 늘어난다. 화면에 보이는 라벨만
바뀌면 되는 요청이라 id를 유지하는 게 최소 변경 원칙에 맞는다).

새 최상위 탭 `nav-sharing` / `panel-sharing`을 `nav-thoughts`와
`nav-settings` 사이에 추가한다. `showPanel()`의 배열을
`['brief','thoughts','sharing','settings']`로 바꾼다.

### 3-2. Sharing Thoughts를 독립 탭으로 승격

`sub-mine`의 내용(작성 카드 + `thought-feed` + `더 보기` 버튼)을 그대로
`panel-sharing`으로 옮긴다. 서브 탭이 필요 없는 단일 목적 패널이라
`panel-brief`/`panel-settings`처럼 sub-nav 없이 바로 카드들을 나열한다.
`sub-btn-mine`/`sub-mine`은 `panel-thoughts`에서 삭제한다.

관련 JS는 id만 유지하면 그대로 재사용 가능하다 — `thoughtCardHtml`,
`postThought`, `toggleComments`, `postComment`, `editThought` 등
`spec_firebase_thoughts.md`에서 만든 함수들은 전부 DOM id 기준으로
동작해서 부모 컨테이너가 어느 패널에 있는지와 무관하다. `enterApp()`의
`if (!feedLoaded) initThoughtsFeed();` 호출도 그대로 둔다.

### 3-3. Archive를 Daily Briefing 안으로

`panel-brief` 카드 위에 작은 토글(기존 `.sub-nav` 스타일 재사용) 두 개
`Today` / `📚 Archive`를 추가하고(6번에서 확정한 "기본 언어는 영어"
원칙에 맞춰 영어로 쓰고 `data-i18n` 대상에 포함시킨다 — 검증 중 초안에
한국어 라벨이 섞여 있던 걸 발견해서 고쳤다), `showBriefView(view, btn)`
함수(`showSubPanel`과 동일한 패턴)로 두 뷰를 전환한다. 기존 브리핑
카드는 `#briefview-today`로 감싸고, `sub-archive`의 내용(키워드 검색
입력 + `archive-cards` + 3-4의 trend 분석 카드)은 새 `#briefview-archive`
블록으로 옮긴다. `panel-thoughts`에서 `sub-btn-archive`/`sub-archive`는
삭제한다.

Personal Tool의 sub-nav는 이제 Search Stories / Legal Q&A / Compare
세 개만 남는다. `showSubPanel()` 배열을 `['search','qa','compare']`로
줄이고, 기본 활성 탭을 Search Stories로 바꾼다(원래 있던 4개 중
남은 것들의 자연스러운 진입점이라고 판단해서 내가 결정 — 사용자
취향 문제라기보다 어느 게 첫 화면으로 와도 무방한 동등한 선택지들
중 하나를 고르는 것뿐이라 인터뷰 없이 결정).

cross-link 두 곳을 수정한다.

- Legal Q&A의 "Load from archive" 버튼 — 기존
  `onclick="showSubPanel('archive', ...)"`를
  `onclick="showPanel('brief', document.getElementById('nav-brief')); showBriefView('archive', document.getElementById('brief-view-archive-btn'))"`
  로 바꾼다.
- `loadArchiveToQA(idx)` — 함수 맨 앞에
  `showPanel('thoughts', document.getElementById('nav-thoughts'));`를
  추가한다(Archive가 이제 `panel-brief`에 있고 Legal Q&A는
  `panel-thoughts`에 있어서, 패널을 먼저 전환하지 않으면
  `showSubPanel('qa', ...)`가 보이지 않는 패널 안에서 조용히
  실패한다).

## 4. Archive Firestore 동기화 + 키워드 검색 (3)+(6)

### 4-1. 데이터 모델

새 컬렉션 `users/{nickname}`(문서 하나 = 그 닉네임의 프로필)과 그
서브컬렉션 `users/{nickname}/archive/{entryId}`를 추가한다.

```
users/{nickname}
  urls:        string[]
  topics:      { ip, reg, lit, corp: boolean }
  sectors:     { technology, finance, healthcare, realestate, energy,
                 retail, media, manufacturing, startup: boolean }
  keywords:    string[]
  companies:   string[]
  lang:        string   ('en'|'ko'|'es'|'fr'|'zh'|'ja', 기본 'en')
  trendConfig: { topics: string[], days: number }  (기본 { topics: [], days: 7 };
               5-1에서 카운트 기반 count를 기간 기반 days로 교체)
  archiveSchedule: string[]  (예: ['08:00','17:00'], 기본 []; 5-2 — 기존
               Daily Alarm을 대체하는 다중 시각 자동 생성 스케줄)
  updatedAt:   Timestamp

  archive (서브컬렉션)
    {entryId}
      date, time, topicsLabel: string
      html, context:           string  (기존 entry.html/entry.context 그대로)
      articles:                array   (기존 entry.articles 그대로)
      createdAt:                Timestamp
```

닉네임을 문서 ID로 직접 쓴다(예: `users/samve`). 슬래시(`/`)가 들어간
닉네임은 Firestore 문서 경로를 깨뜨리므로, 게이트의 닉네임 입력
검증에 "`/` 문자 금지"를 추가한다(길이 제한 1~20자는 기존 그대로).

### 4-2. 왜 이 구조가 신뢰 모델과 맞는지 (중요 — 리스크 섹션과 연결)

`thoughts`/`comments`는 `authorUid`(Anonymous Auth uid)로 소유권을
증명했지만, 이번 `users/{nickname}` 문서는 애초에 "닉네임만 같으면
어느 기기에서든 같은 프로필을 이어본다"는 게 요청의 핵심이라, uid
기준 소유권 검증을 걸 수가 없다 — 그렇게 하면 다른 기기(=다른
Anonymous uid)에서 정당하게 이어보려는 시도까지 막히기 때문이다.
그래서 이 컬렉션의 쓰기 규칙은 "익명 로그인이 되어 있으면(스팸
방지 최소선) 그 닉네임 문서에 쓸 수 있다"는 수준까지만 강제할 수
있고, "이 닉네임은 진짜 이 사람 것"이라는 보장은 없다 — 즉 누군가
친구의 닉네임을 그대로 입력하면 그 친구의 저장된 sources/topics를
읽거나 덮어쓸 수 있다. 이건 이미 `spec_firebase_thoughts.md` 8번
섹션에서 받아들이기로 한 "닉네임 위장 방지 안 함" 리스크의 연장선인데,
이번엔 대상이 공개 게시물이 아니라 개인 설정값이라는 점에서 무게가
약간 다르다 — 8번 리스크 섹션에 이 내용을 추가로 기록해 둔다(9번
참고).

### 4-3. Firestore 보안 규칙 추가 (`firestore.rules`에 병합)

**갱신 — 이 블록은 이후 `spec_firebase_thoughts.md` 12번(닉네임 중복
방지)에서 uid 기반 소유권 규칙으로 한 번 더 교체됐고, 실제
`firestore.rules`도 그 버전이 최종본이다.** 여기 원래 있던
`allow read: if true` / `allow write: if request.auth != null`(닉네임만
알면 누구나 쓰기 가능하던 초안)는 더 이상 유효하지 않다 — 지금은
`request.auth.uid == resource.data.ownerUid`로 실제 계정 소유권을
검증한다. 이번 5-2 변경사항(`archiveSchedule` 필드 추가)은 최종본
기준으로 `keys().hasOnly([...])` 목록에 `'archiveSchedule'`을
추가하는 것뿐이다 — 최신 전체 규칙은 `spec_firebase_thoughts.md`
12-3과 실제 `firestore.rules` 파일을 참고한다.

Archive 항목은 만든 뒤 절대 안 바뀌는 히스토리 기록이라 수정·삭제를
아예 막았다 — 나중에 정리가 필요해지면 그때 별도 관리자 도구를
고민하면 되고, 지금 범위에서 클라이언트용 삭제 기능을 만드는 건
과하다고 판단했다.

### 4-4. 동기화 흐름

`enterApp()`(`spec_firebase_thoughts.md`에서 만든 함수) 안에서,
게이트를 숨기고 앱을 보여준 직후 두 개를 병렬로 비동기 호출한다 —
`loadUserProfile(nickname)`과 `loadArchiveFromCloud(nickname)`. 앱
화면 전환 자체는 이 호출을 기다리지 않는다(Sharing Thoughts의
`initThoughtsFeed()`처럼, 로컬 기본값으로 먼저 그리고 나중에
Firestore 값이 오면 갱신하는 기존 패턴을 그대로 따른다).

`loadUserProfile`은 `getDoc(doc(db,'users',nickname))`을 읽어서
문서가 있으면 `S.urls/topics/sectors/keywords/companies/lang/
trendConfig`를 덮어쓰고, Sources & Topics 화면의 pill·chip·url
목록과 언어 선택 UI를 다시 그린다. 문서가 없으면(처음 쓰는 닉네임)
아무것도 안 하고, 첫 설정 변경 때 자동으로 문서가 생긴다.

기존 `toggleTopic`/`toggleSector`/`addKeyword`/`removeKeyword`/
`addCompany`/`removeCompany`/`addUrl`/`removeUrl` 각 함수 끝에
`syncUserProfile()` 호출을 한 줄씩 추가한다. `syncUserProfile()`은
현재 `S`의 관련 필드를 모아
`setDoc(doc(db,'users',nickname), {...S 필드들, lang, trendConfig, updatedAt: serverTimestamp()}, {merge:true})`
로 저장한다 — 기존 `localStorage.setItem(...)` 호출은 그대로 두고
그 옆에 추가하는 것뿐이라(오프라인 캐시 + 즉시 반영용으로 계속
유용함), 기존 로직을 건드리지 않는다.

`loadArchiveFromCloud`는
`query(collection(db,'users',nickname,'archive'), orderBy('createdAt','desc'), limit(50))`
로 최근 50개를 가져와 `S.archive`를 교체하고 `renderArchive()`를
호출한다. `generateBriefing()`의 저장 부분(`index.html:959-962`)에는
기존 `localStorage` 저장 옆에, **`nickname`이 비어있지 않을 때만**
`addDoc(collection(db,'users',nickname,'archive'), {...entry, createdAt: serverTimestamp()})`
호출을 추가한다.

이 가드가 꼭 필요한 이유는 검증 과정에서 확인했다 — 코드 맨 끝의
`startBriefing()`(`index.html:772-783`)이 페이지가 열리자마자, 즉
사용자가 닉네임 게이트를 통과하기 **전에** 오늘자 캐시가 없으면
`generateBriefing()`을 자동으로 호출한다. 이 시점엔 `nickname`
변수가 빈 문자열이라, 가드 없이 그대로 `addDoc(...,'users',nickname,...)`
를 호출하면 빈 문서 경로로 Firestore 요청을 보내게 된다(콘솔 에러가
나거나 최악의 경우 잘못된 경로에 쓰기 시도가 발생한다). 같은 이유로
Daily Alarm의 `setInterval`(`index.html:675-687`)도 게이트를 지나지
않은 상태에서 트리거될 수 있어 동일한 가드가 필요하다.

가드를 걸면 "게이트를 통과하기 전에 자동 생성된 첫 브리핑"은 그
세션에서 `localStorage`(`todayKey()`)에만 남고 Firestore Archive에는
안 올라간다 — 화면의 "오늘의 브리핑" 뷰에는 정상적으로 보이지만
Archive 히스토리에는 게이트를 지난 뒤 처음 새로 생성(또는 Renew)한
브리핑부터 쌓이기 시작한다. 이 정도는 실사용에 지장 없는 사소한
엣지케이스라고 보고 별도 보정 로직(예: 로그인 후 대기 중이던 로컬
엔트리를 뒤늦게 업로드)은 만들지 않는다.

### 4-5. 키워드 검색

`#briefview-archive` 상단에 검색 입력창을 하나 추가한다. 입력할
때마다(`oninput`) `S.archive`를 순회해서 `date`, `topicsLabel`,
`context`(브리핑 본문 텍스트) 세 필드 중 하나라도 검색어를
포함하면(대소문자 무시) 보여주고 아니면 숨기는 방식의 클라이언트
필터링이다. Firestore는 전문 검색(full-text search)을 기본 지원하지
않고, 이미 불러온 최근 50개 안에서 찾는 용도라 서버 쿼리를 추가로
만들 필요 없이 `renderArchive()`가 그리는 DOM에 `display:none` 토글만
하면 충분하다 — 검색 서비스를 새로 붙이는 건 이 규모에서 과한
설계라고 판단했다.

## 5. Trend 분석 + 자동 Archive 생성 (4)

이 섹션은 원래 "최근 N개 브리핑 분석"(카운트 기반)으로 설계했다가,
사용자가 추가 요청 4가지(기간 기반 설정, archive 자동 생성, 그 자동
생성 스케줄도 사용자가 설정, 이메일 발송 옵션)를 주면서 다시 설계했다.
인터뷰 결과 — 자동 생성은 **클라이언트사이드 best-effort**(지금 Daily
Alarm과 같은 방식, 새 서버 인프라 없음)로 가고, **이메일 발송은 이번
범위에서 보류**한다(실제 이메일을 보내려면 브라우저에서 할 수 없는
서버 주기 작업이 필요하고, 이 앱이 지금까지 전혀 안 모으던 이메일
주소까지 받아야 해서 별도 인프라 결정이 필요한 큰 후속 작업으로
분리했다). 아래는 그 결과 확정된 범위다.

### 5-1. Trend 분석 기간 설정 (요청 a)

"최근 N개 브리핑" 대신 **기간(날짜 범위)** 기준으로 바꾼다. `#briefview-archive`
안, 검색창과 archive 목록 사이에 "📈 Trend Analysis" 카드를 추가한다.

- 기간 선택 — "지난 7일" / "지난 1개월(30일)" / "지난 3개월(90일)"
  프리셋 버튼 3개 + "직접 입력" 숫자 칸(일 단위, 예: 21). 프리셋을
  누르면 숫자 칸에 그 값이 채워지고, 숫자 칸은 언제든 직접 고쳐서
  임의의 기간을 만들 수 있다 — "예시(7일/1달/3개월)로 자유롭게
  설정 가능"이라는 요청을 프리셋 + 자유 입력 조합으로 만족시켰다.
- topic 다중 선택 — 기존 Legal Topics(`ip`/`reg`/`lit`/`corp`) +
  Business Sectors pill 재사용(Daily Briefing 자체의 활성 topic과는
  별개 상태로 관리).
- "트렌드 분석 실행" 버튼.

이 설정은 `S.trendConfig = { topics: string[], days: number }`(기존
`count` 필드를 `days`로 교체)에 저장되고, 4-4의 `syncUserProfile()`이
다른 설정과 함께 Firestore에 동기화한다.

### 5-2. Archive 자동 생성 + 스케줄 설정 (요청 b, c)

**Sources & Topics 패널의 기존 "Daily Alarm" 카드를 통째로 삭제하고
"Archive Schedule" 카드로 교체한다** — 사용자가 "sources 페이지에 있는
알람을 삭제해달라"고 명시적으로 요청했고, 이번 기능이 그 자리를
대체한다(하루 한 번 시각 설정 → 하루 여러 번 시각 설정 + 기존
Legal Topics/Business Sectors/Tracked Companies를 그대로 재사용하는
방식으로 확장).

- UI — 시각 입력(`<input type="time">`) 목록 + "+ 시간 추가" 버튼
  (요청 예시대로 "매일 아침 8시" 하나만 설정할 수도, "오전 8시 +
  오후 5시" 두 개를 설정할 수도 있게). 각 항목 옆에 삭제 버튼. 기존
  Daily Alarm에 있던 "🔔 Allow notifications" 버튼(`notif-btn`)과
  브라우저 알림 발송 로직은 그대로 가져온다 — 예약 생성이 실제로
  끝났을 때 알려주는 용도로 여전히 유효하고, plan-verify 중 처음
  초안에서 이걸 빠뜨렸다가 다시 넣었다. "몇 시에 자동 생성할지"만
  설정하고, "무엇을 요약할지"는 별도 선택 UI를 안 만든다 — 사용자가
  말한 "내가 설정한 토픽, 회사, 법령 등"이 정확히 지금 Sources &
  Topics의 Legal Topics/Business Sectors/Tracked Companies 설정
  그 자체이므로, 예약 생성도 수동 "Renew"와 완전히 같은
  `generateBriefing()`을 그대로 호출해서 그 시점의 현재 설정을
  그대로 쓰면 된다 — 별도 설정을 중복으로 만들 필요가 없다.
- 데이터 — 기존 `const ALARM = { enabled:false, time:'08:00' }`를
  `const ALARM = { times:['08:00'] }`(단일 문자열 → 배열, `enabled`
  필드는 없앤다 — 배열이 비어있으면 그 자체로 "끔"이라 별도 boolean이
  불필요한 상태를 하나 더 만드는 셈이었다)로 바꾼다. `localStorage`
  (`lb_alarm`) 저장은 유지하고, `syncUserProfile()`에도
  `archiveSchedule: ALARM.times`를 추가해서 기기 간 동기화되게 한다.
- 실행 로직 — 기존 `setInterval(...,30000)` 폴링(`index.html:695-707`)
  을 `ALARM.time` 단일 값 비교에서 `ALARM.times.forEach(t => ...)`
  순회로 바꾼다. 각 시각마다 독립적으로
  `lb_alarm_fired_${date}_${time}` 키로 하루 1회만 실행되는 기존
  중복 방지 로직을 그대로 재사용한다(시각별로 키가 달라서 자연스럽게
  각 시각마다 따로 추적된다). 브라우저 탭이 그 시각에 열려있어야만
  실행된다는 한계는 기존 Daily Alarm과 동일하다(인터뷰에서 확인·수용).

### 5-3. Trend 분석 실행

"트렌드 분석 실행" 버튼을 누르면 `S.archive`에서 `createdAt`이
`days`일 이내인 항목만 골라낸다. Firestore에서 불러온 항목은
`createdAt`이 진짜 Firestore `Timestamp`(`.toMillis()` 사용 가능)지만,
이번 세션에 막 생성돼 아직 클라우드 왕복을 안 거친 로컬 항목은
`createdAt` 필드가 아예 없고 `id`(생성 시각의 epoch ms, `index.html:951`
`id: now.getTime()`)만 있다 — 그래서 필터는
`(e.createdAt ? e.createdAt.toMillis() : e.id) >= Date.now() - days*86400000`
처럼 두 경우를 다 처리해야 한다(구현 중 놓치기 쉬운 지점이라 미리
명시해 둔다).

각 항목의 `context`는 `generateBriefing()`(`index.html:895-900`)이
`[Topic Label]\n불릿들\n prose` 형태의 블록을 topic별로 만들어
`\n\n`으로 이어붙인 문자열이다. 이 구조를 그대로 활용해서, 선택된
topics의 라벨과 대괄호로 시작하는 블록만 골라내는 방식으로 필터링한다
— `context.split('\n\n').filter(block => selectedLabels.some(l => block.startsWith('['+l+']')))`.
별도 구조화 없이 이미 있는 문자열 규칙을 재사용하는 것이라 데이터
모델을 새로 안 만들어도 된다. 새 서버 엔드포인트는 만들지 않는다 — `generateBriefing()`이
이미 `/api/chat`을 클라이언트에서 직접 호출하는 것과 같은 패턴으로,
`runTrendAnalysis()` 함수가 `/api/chat`에 다음과 같은 system prompt로
직접 요청한다.

```
"You are a legal trend analyst. Given these legal briefings from the
last {days} days, identify emerging patterns, recurring themes, and
directional shifts over time, focused on: [선택된 topic 라벨들].
Reply ONLY as JSON:
{"summary":"...", "trends":[{"title":"...","direction":"rising|stable|declining","description":"..."}]}"
```

결과는 기존 `.biz-card` 스타일을 재사용한 카드로 렌더링한다(방향
표시는 `risk-badge`류 색상 재사용 — 상승`risk-high` 유사 톤, 하락은
`risk-low` 유사 톤, 유지는 `risk-medium` 톤). 분석 결과는 Firestore나
localStorage에 저장하지 않고 JS 변수(`lastTrendResult`)에만 담아
페이지를 새로고침하기 전까지 유지한다 — 사용자가 원할 때만 돌리는
기능이라(인터뷰 결정), 굳이 영구 저장까지 할 필요는 없다고 판단했다.
선택한 기간 안에 브리핑이 2개 미만이면(비교할 대상이 없으므로)
"분석할 브리핑이 충분하지 않아요(최소 2개 필요)" 안내로 대체한다.

### 5-4. 이메일 발송 옵션 (요청 d) — 이번 범위에서 보류

인터뷰에서 확정된 대로 이번엔 만들지 않는다. 실제로 구현하려면 (1)
브라우저에서 직접 메일을 못 보내므로 서버 주기 작업(Render Cron Job
등, 월 소액 비용) 신설, (2) 그 작업이 Firestore를 읽으려면 Firebase
관리자 자격 증명(서비스 계정 키)을 서버 환경변수로 등록, (3) 이메일
발송 서비스(예: Resend, 무료 등급 존재) 가입과 API 키 발급, (4) 이
기능을 켜는 사용자에 한해 실제 이메일 주소를 처음으로 수집(지금까지
이 앱은 닉네임 외 개인정보를 전혀 안 모았다는 원칙과 충돌) — 이
네 가지 다 사용자의 별도 승인·가입이 필요한 인프라 결정이라, 이번
Trend/Archive Schedule 작업과 분리해서 나중에 별도 spec으로 다룬다.

## 6. 다국어 지원 (5)

### 6-1. 범위와 방식

고정 UI 텍스트만 번역한다(인터뷰 결정). 지금 코드에 섞여 있는 영어
라벨("Daily Briefing", "Search Stories" 등)과 한국어 라벨("내
생각", "게시", "댓글 N개", "닉네임을 입력하고 시작하세요" 등)을
전부 영어를 **기본값**으로 통일하는 작업이 선행돼야 한다 — 지금
상태 자체가 언어가 섞여 있어서, 요청하신 "기본적으로 모두 영어"를
만족하려면 한국어로 쓴 부분들을 전부 영어 원본으로 다시 쓰고, 그
영어 문구를 `en` 키로 삼아 6개 언어 사전을 만드는 순서가 된다.

번역 대상 문구는 대략 100~150개(내비게이션 6개, sub-nav 8개, 카드
제목/버튼/placeholder/안내문구 전부 포함)로 추정되고, 제가 직접
6개 언어로 작성한다 — 외부 번역 API를 새로 붙이는 게 아니라 텍스트
그 자체를 정적 사전으로 미리 박아두는 방식이라 실행 시 비용이나
지연이 없다. 다만 이건 AI가 작성한 번역이라 원어민 검수를 거친
전문 번역은 아니라는 점은 명시해 둔다 — UI 문구 수준이라 오역
리스크가 낮긴 하지만(법률 자문 콘텐츠 자체가 아니라 버튼/메뉴
문구이므로), 실제 사용해 보시고 어색한 표현이 있으면 언제든 개별
수정 가능하다.

### 6-2. 구현 방식

번역 가능한 요소에 `data-i18n="key"`(텍스트 콘텐츠용) 또는
`data-i18n-ph="key"`(placeholder용) 속성을 추가한다. 새 사전 객체
`I18N = { en: {...}, ko: {...}, es: {...}, fr: {...}, zh: {...}, ja: {...} }`
를 모듈 스크립트에 정의하고, `applyLanguage(lang)` 함수가
`document.querySelectorAll('[data-i18n]')`을 순회하며
`el.textContent = I18N[lang][key] || I18N.en[key]`로 갈아끼우고,
`[data-i18n-ph]`는 `el.placeholder`를 갈아끼운다.

**범위 경계를 이번에 한 번 더 분명히 한다** — "고정 UI 텍스트"와
"AI가 생성하는 콘텐츠"를 가르는 기준은 "정적 HTML이냐 JS가 그리냐"가
아니라 "누가 쓴 문구냐"다. Daily Briefing 본문, Trend 분석 결과,
Sharing Thoughts 글/댓글은 AI나 다른 사용자가 그때그때 생성하는
콘텐츠라 번역 범위 밖이 맞다. 반면 `timeAgo()`의 "3분 전" 같은
상대 시간 표시, "댓글 N개" 카운터, "불러오는 중…"/"아직 등록된
의견이 없어요" 같은 로딩·빈 상태 문구, `alert()`/`confirm()`으로
뜨는 "정말 삭제할까요?"/"비밀번호가 틀렸어요" 같은 문구는 전부
개발자가 미리 써둔 고정 UI 카피가 JS로 삽입될 뿐이라 — 정적 HTML과
본질적으로 같은 범주다. 이런 것까지 번역 안 하면 나머지 화면은
언어가 바뀌었는데 이런 문구들만 계속 한국어/영어로 남아서 오히려
더 어색해진다. 그래서 이번엔 이 부류도 전부 포함한다.

이런 동적 문구를 위해 작은 헬퍼 `t(key, vars)`를 추가한다 —
`I18N[currentLang][key] || I18N.en[key]`를 가져와서 `vars` 객체의
플레이스홀더(`{n}` 같은 토큰)를 치환해 반환한다. 예:
`t('commentCount', {n: 3})` → 영어는 `"💬 3 comments"`, 한국어는
`"💬 댓글 3개"`. 기존 코드에서 `alert(...)`, `confirm(...)`,
`el.textContent = '...'` 형태로 하드코딩돼 있던 문자열들을 이
헬퍼 호출로 하나씩 바꾼다 — 정적 마크업의 `data-i18n`보다 손이
더 가는 작업이라 별도로 명시해 둔다.

언어 선택 `<select>`를 시작 화면 헤더와 메인 앱 헤더(`#hdate` 근처)
두 곳에 추가한다. 선택하면 즉시 `applyLanguage()`가 실행되고,
`localStorage.setItem('lexbrief_lang', lang)`으로 즉시 저장한다.
닉네임으로 로그인한 뒤에는(4-4의 `loadUserProfile`) Firestore에 저장된
`lang` 값이 있으면 그 값으로 다시 한번 `applyLanguage()`를 실행해서
기기 간 언어 설정도 따라오게 한다 — localStorage 값은 "이 브라우저
에서 마지막으로 쓴 언어"로, Firestore 값은 "이 닉네임의 언어 설정"
으로 역할이 분리되고, 로그인 후에는 후자가 우선한다.

반대 방향도 챙겨야 한다 — 로그인 이후(메인 앱 헤더) 언어 선택기를
바꾸면 `applyLanguage()` + localStorage 저장에 더해 `syncUserProfile()`
도 같이 호출해서 `lang` 값을 Firestore에 반영한다(다른 설정 변경
함수들과 동일한 패턴). 반면 시작 화면(게이트)의 언어 선택기는 아직
닉네임을 모르는 시점이라 Firestore에 쓸 대상 자체가 없으므로
localStorage 저장까지만 하고 동기화는 하지 않는다.

### 6-3. 기본값

저장된 언어 설정이 전혀 없는 첫 방문에는 `en`이 기본값이다(요청하신
"시작페이지하고 웹사이트는 기본적으로 모두 영어로 설정"을 그대로
반영). 브라우저의 `navigator.language`를 보고 자동으로 다른 언어를
추측하는 기능은 넣지 않는다 — 명시적으로 "기본은 영어"라고 하셨고,
자동 추측은 요청에 없는 범위라 뺐다.

## 7. 구현 단계 (권장 순서)

한 번에 다 구현하기엔 범위가 크다 — 아래 순서로 나눠서 진행하는 걸
권장한다(각 단계가 그 자체로 완결돼서 중간에 멈춰도 앱이 깨지지
않는다).

1. **내비게이션 재구성**(3번) — nav 이름 변경, Sharing Thoughts 분리,
   Archive를 Daily Briefing으로 이동, cross-link 두 곳 수정. 이
   단계만으로도 이미 화면 구조가 요청대로 바뀐다.
2. **Archive Firestore 동기화 + 키워드 검색**(4번) — `users/{nickname}`
   컬렉션과 규칙 추가, `enterApp()`에 동기화 호출 연결, 검색 입력 추가.
3. **Sources & Topics 프로필 동기화**(4-4 후반부, 6번 요청) — 기존
   설정 함수들에 `syncUserProfile()` 한 줄씩 추가.
4. **Trend 분석**(5번) — 설정 UI + `runTrendAnalysis()`.
5. **다국어 지원**(6번) — 가장 손이 많이 가는 단계. 먼저 한국어로
   쓰인 기존 UI 문구를 전부 영어로 교체(기본값 통일) → `data-i18n`
   속성 부여 → 6개 언어 사전 작성 → 언어 선택 UI + `applyLanguage()`.

## 8. 테스트 plan

- 내비게이션 4개 탭이 전부 정상적으로 전환되는지, 특히 Legal Q&A ↔
  Daily Briefing/Archive 간 두 cross-link이 양방향으로 잘 동작하는지
  (3-3에서 고친 부분이 이번 개편에서 가장 깨지기 쉬운 지점).
- 브라우저 A에서 닉네임으로 Sources & Topics를 바꾸고, 브라우저
  B(다른 세션)에서 같은 닉네임으로 로그인해서 그 설정이 그대로
  복원되는지 확인.
- 브라우저 A에서 브리핑을 하나 생성 → Firestore에 `users/{nickname}
  /archive`에 문서가 생기는지 → 브라우저 B에서 같은 닉네임으로
  들어가 그 Archive가 보이는지 확인.
- Archive 키워드 검색이 날짜/topic/본문 중 어디에 매치돼도 걸리는지,
  매치 없을 때 빈 상태 문구가 뜨는지.
- 브리핑이 1개뿐인 상태에서 Trend 분석을 눌러 "브리핑이 충분하지
  않다" 안내가 뜨는지, 2개 이상이면 정상적으로 분석이 도는지.
  기간 프리셋(7일/1개월/3개월) 버튼을 누르면 숫자 칸이 그 값으로
  바뀌는지, 숫자 칸을 직접 고쳐서 임의의 기간으로도 필터링되는지.
  Firestore에서 불러온 항목(진짜 `Timestamp`)과 이번 세션에 막
  생성돼 아직 클라우드 왕복 전인 로컬 항목(`id`만 있음)이 섞인
  상태에서 기간 필터가 둘 다 올바르게 처리하는지(5-3에서 미리
  짚어둔 지점).
- **Archive Schedule(구 Daily Alarm)** — 시각을 두 개(예: 지금 시각
  1분 후, 2분 후) 등록하고 각각 독립적으로 그 시각에
  `generateBriefing()`이 자동 실행되는지, 하루 안에 같은 시각으로
  두 번 안 겹쳐 실행되는지(기존 dedup 로직 재사용 확인). Sources &
  Topics 패널에서 Daily Alarm 카드 자체가 사라지고 Archive Schedule
  카드로 대체됐는지. 등록한 시각들이 `archiveSchedule`로 Firestore에
  동기화되어 다른 세션에서 같은 닉네임으로 들어가도 그대로 보이는지.
- 언어 선택기로 6개 언어를 하나씩 돌아가며 눌러서 `data-i18n` 요소가
  전부 깨짐 없이 바뀌는지(3-3에서 새로 추가한 Today/Archive 토글
  라벨 포함), 새로고침 후에도 마지막 선택 언어가 유지되는지, 닉네임
  로그인 후 Firestore의 `lang` 값이 우선 적용되는지, 로그인 후
  메인 앱에서 언어를 바꾸면 그 값이 Firestore에도 저장되는지(다른
  기기에서 확인).
- **페이지를 새로 열자마자(닉네임 게이트 통과 전) 자동 생성되는
  첫 브리핑** — `startBriefing()`이 게이트보다 먼저 실행되는 기존
  동작이 그대로 유지되는지, 이때 `nickname`이 비어있어 Firestore
  Archive 쓰기를 건너뛰는지(콘솔 에러 없이), 로컬 "오늘의 브리핑"
  뷰에는 정상적으로 표시되는지 확인. Daily Alarm이 게이트 통과 전에
  울리는 경우도 동일하게 확인.
- 보안 규칙 회귀 — 개발자 도구에서 로그인 안 한 상태로
  `users/{nickname}` 문서에 직접 쓰기 시도 시 거부되는지(익명 로그인
  자체는 앱 진입 시 자동으로 되므로, 이 테스트는 `signOut()`으로
  강제 로그아웃한 뒤 시도해야 한다).

## 9. 리스크 / 엣지케이스

4-2에서 설명한 대로, `users/{nickname}` 동기화는 닉네임을 아는
누구나 그 프로필을 읽고 덮어쓸 수 있다는 걸 다시 한번 강조해 둔다
— `spec_firebase_thoughts.md` 8번의 "닉네임 위장 방지 안 함" 리스크가
이번엔 공개 게시물이 아니라 개인 설정(어떤 소스·토픽을 구독하는지)
까지 확장된다는 점이 이번 스펙에서 새로 생긴 부분이다. 친구들끼리
쓰는 캐주얼한 도구라는 맥락에서 인터뷰를 통해 이 트레이드오프를
받아들이기로 확정했지만, 실사용 중 문제가 생기면(예: 장난으로 남의
설정을 자꾸 바꾸는 경우) 그때 가서 닉네임에 PIN 코드 같은 최소
인증을 추가하는 걸 후속 작업으로 고려할 수 있다.

Archive가 Firestore로 옮겨가면서 `S.archive`가 이제 비동기로 채워지기
때문에, 페이지 로드 직후(아직 닉네임도 안 넣은 시작 화면 단계)에는
Archive가 비어 있는 게 정상이다 — 게이트를 통과하기 전까지는
`users/{nickname}` 자체를 알 수 없으므로 당연한 제약이고, 별도 처리
없이 그대로 둔다.

다국어 사전 작성은 실수로 일부 언어에서 키가 누락될 수 있는
위험이 있다 — `applyLanguage()`가 `I18N[lang][key] || I18N.en[key]`로
영어 폴백을 두는 이유가 이거다(키가 없으면 깨진 화면 대신 영어로
대체 표시).

## 10. Self-review

**베스트 plan인지** — 새 서버 엔드포인트나 외부 번역/검색 서비스를
하나도 추가하지 않고, 이미 검증된 패턴(모듈 스크립트, `/api/chat`
직접 호출, `data-*` 속성 기반 치환)만으로 6개 요청을 전부 만족시켰다.
클라이언트 단일 파일 구조라는 제약 안에서 가장 낮은 인프라 비용으로
가는 경로라고 판단한다.

**빠진 게 있는지** — 다국어 사전의 실제 문구 목록(어떤 key에 어떤
영어 원문이 들어가는지)은 이 문서에 전부 나열하지 않았다 — 구현
단계에서 `index.html`의 실제 하드코딩된 문자열을 하나씩 훑으며
`data-i18n` key를 부여하는 게 더 정확하고, 미리 목록만 만들면 구현
중 빠뜨리는 문구가 생길 위험이 있다고 판단해서 뺐다.

**오버한 게 있는지** — Archive 자동 정리(오래된 항목 삭제),
`users/{nickname}`에 진짜 소유권 인증(PIN 등) 추가, 브라우저 언어
자동 감지는 전부 요청에 없거나 인터뷰에서 명시적으로 뺀 범위라
넣지 않았다. Trend 분석 결과를 영구 저장하는 것도(수동 실행이라는
인터뷰 결정과 맞지 않아서) 넣지 않았다. 다만 한 가지는 스스로
스코프를 넓힌 부분이라 투명하게 밝혀둔다 — 4-4/5-1에서 `trendConfig`
(트렌드 분석용 topic·개수 설정)를 Sources & Topics와 같은 Firestore
문서에 묶어 기기 간 동기화되게 했는데, 이건 사용자가 "source와
topic"이라고 명시한 범위를 살짝 넘는 결정이다. Sources & Topics만
동기화하고 trendConfig는 로컬에만 남기는 것도 요청 문구엔 더 충실한
선택이지만, 그렇게 하면 다른 설정은 다 따라오는데 트렌드 분석
설정만 기기마다 따로 노는 어색한 경험이 될 것 같아 일관성을 택했다
— 원치 않으시면 trendConfig만 로컬 전용으로 되돌리는 건 구현 단계
에서 쉽게 뺄 수 있는 부분이다.

**테스트 충분한지** — 8번에 핵심 회귀(cross-link, 언어 폴백, 보안
규칙)를 포함해 뒀다. 다만 6개 언어 전체를 사람이 읽고 자연스러운지
검수하는 건 자동화된 테스트로 커버할 수 없는 부분이라, 구현 완료
후 실제 화면을 언어별로 캡처해서 사용자가 눈으로 한 번 훑어보는
과정이 필요하다는 점은 미리 밝혀둔다.

## 11. 사용자 결정 필요 항목

인터뷰로 이미 3개 다 확정됐다(0번 참고). 구현 단계에서 추가로
필요한 사용자 액션은 없다 — Firebase 프로젝트나 Anonymous Auth
설정은 `spec_firebase_thoughts.md`에서 이미 끝난 상태라 재사용
가능하고, 이번 스펙은 같은 Firestore 데이터베이스에 컬렉션만
추가하는 구조라 콘솔에서 새로 켜야 하는 기능이 없다. 다만 규칙
파일이 다시 바뀌므로(4-3), 구현 완료 후에는 이전과 마찬가지로
Firebase 콘솔의 "규칙" 탭에 갱신된 `firestore.rules`를 다시
붙여넣어 게시해야 한다.
