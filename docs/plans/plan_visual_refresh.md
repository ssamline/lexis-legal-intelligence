# Plan: 비주얼 리프레시 — 웜 뉴트럴 팔레트 + Sharing Thoughts 아바타 + Sources & Topics 아코디언

## 0. 인터뷰 결과 (사용자 선택)

- **색상 방향**: 웜 뉴트럴(크림/차콜) — 현재의 네이비+골드 "로펌스러운" 톤을 벗어나 더 따뜻하고 접근하기 쉬운 느낌으로.
- **Sharing Thoughts**: 이니셜 아바타 + 카드 좌측 액센트 바 (추천안 그대로).
- **Sources & Topics**: 아코디언(접기/펼치기)을 기본 구조로 하되, 옵션 1의 "아이콘·개수 표시 + 자주 안 쓰는 카드는 톤 낮추기"를 섞음.
- (이미 별도로 완료됨) 언어 드롭다운 옵션이 흰 배경에 흰 글씨로 안 보이던 버그 — `#app-lang-select option`에 색을 명시해서 수정 완료.

## 1. 관련 코드 조사 결과

- 전체 색상은 `index.html` 5~19번째 줄의 `:root` CSS 변수로 관리된다: `--ink/--ink2/--ink3`(본문 텍스트 3단계), `--rule`(테두리), `--surface`(페이지 배경), `--white`(카드 배경), `--accent/--accent-light`(주 액센트), `--gold/--gold-light`(보조 액센트), 그리고 topic pill·badge용 `--tag-*` 6쌍, `--radius`, `--shadow`. 대부분의 컴포넌트가 하드코딩 색이 아니라 이 변수들을 참조하고 있어서, **변수 값만 바꾸면 전체 룩을 바꿀 수 있다** — 이번 리프레시의 핵심 레버리지.
- 예외적으로 하드코딩된 색이 있는 곳: `.biz-card`(#F0FDF8/#A7F3D0/#10B981 계열 녹색), `.risk-high/medium/low`(빨강/노랑/초록), topic pill의 `--tag-*` 6쌍. 이들은 "브랜드 톤"이 아니라 **의미를 전달하는 기능색**(위험도 높음=빨강, 낮음=초록 등 UX 관례)이라서 이번 웜 톤 리프레시 대상에서 제외한다 — 바꾸면 오히려 사용자가 학습한 색-의미 매핑이 깨진다.
- `.header`는 `background:var(--accent)`를 그대로 쓰고 흰 글씨(`color:#fff`)를 얹는 구조라서, `--accent`를 바꿀 때 흰 글씨와의 명도 대비가 충분한 값을 골라야 한다(대비 확인 필요).
- Sharing Thoughts 카드 마크업은 `thoughtCardHtml(id, th)` 함수(약 2839번째 줄)에서 생성된다. 현재 `.thought-card-head`에 닉네임(`.thought-nick`)과 시간만 나란히 있고 아바타는 없다. `.thought-card` 자체는 `background:var(--white);border:1px solid var(--rule)`뿐이라 좌측 액센트 바가 없다.
- Sources & Topics(`#panel-settings`)는 카드 4개(`Legal Topics` 517번째 줄, `Business Topics` 535번째 줄, `News Sources` 563번째 줄, `Archive Schedule` 578번째 줄)가 전부 `<div class="card-head"><span class="card-title" data-i18n="...">...</span></div>` 형태로 동일한 패턴을 반복하고 있고 접기/펼치기 기능이 전혀 없다.
- 토픽/섹터/키워드/회사/URL/알람 상태는 이미 `S.topics`, `S.sectors`, `S.keywords`, `S.companies`, `S.urls`, `ALARM.times`에 들어있어서 헤더에 개수를 표시하는 데 추가 상태 관리가 필요 없다 — 있는 값을 세기만 하면 된다.
- `localStorage` 패턴이 이미 `lexbrief_topics`, `lexbrief_sectors` 등으로 잘 확립돼 있어서, 아코디언 열림/닫힘 상태도 같은 패턴(`lexbrief_settings_open`)으로 저장하면 기존 관례와 일치한다.

## 2. 색상 팔레트 — 변경안

| 변수 | 기존 | 변경 | 비고 |
|---|---|---|---|
| `--ink` | `#0D1117` (차가운 거의-검정) | `#2B2622` (웜 차콜) | 본문 텍스트 |
| `--ink2` | `#3A3F4A` | `#55504A` | 보조 텍스트 |
| `--ink3` | `#6B7280` | `#746C60` | 메타/캡션 텍스트 — WCAG 대비 계산 결과 반영(검증 단계에서 `#8C8478`이 새 `--surface` 위에서 3.28:1로 AA 미달 판정되어 `#746C60`(대비 4.59:1)으로 조정) |
| `--rule` | `#E2E4E8` (차가운 회색) | `#E8E1D6` (웜 그레이) | 테두리 |
| `--surface` | `#F7F8FA` (차가운 흰색) | `#F5F1E8` (크림) | 페이지 배경 |
| `--white` | `#FFFFFF` | `#FFFFFF` (변경 없음) | 카드가 크림 배경 위에서 또렷하게 떠 보이도록 순백 유지 |
| `--accent` | `#1A3A5C` (네이비) | `#8B4A2C` (테라코타/러스트) | 헤더 배경 + 흰 글씨 대비 확인됨(WCAG AA 통과 범위) |
| `--accent-light` | `#EBF0F7` | `#F5E6DA` | 연한 테라코타 틴트 |
| `--gold` / `--gold-light` | `#B8860B` / `#FDF8EC` | 변경 없음 | 이미 웜 톤이라 새 팔레트와 자연스럽게 어울림 |
| `--radius` | `8px` | `10px` | 카드 모서리를 살짝 더 부드럽게 |
| `--shadow` | `rgba(0,0,0,...)` (차가운 그림자) | `rgba(60,40,20,...)` (웜 틴트 그림자) | 같은 투명도, 색만 웜톤으로 |

`--tag-*` 6쌍과 `.risk-high/medium/low`, `.biz-card`/`.biz-item` 계열 색은 위 1번 조사에서 밝힌 이유로 **변경하지 않는다**.

## 3. 작업 순서

### 3-1. 팔레트 적용 (`index.html` `:root`)
1. 위 표의 값으로 `:root` 변수 교체. 하드코딩된 예외(기능색)는 그대로 둔다.
2. `body`/`.header` 등 변수를 참조하는 곳은 자동으로 새 색을 반영하므로 별도 수정 불필요 — 교체 후 전체 페이지를 훑어 변수 미참조 구간(직접 `#fff`, `rgba(0,0,0,...)` 등을 쓴 곳)이 새 팔레트와 충돌하지 않는지 확인한다.
3. `.card-body` 패딩을 `1.25rem` → `1.375rem`, `.main` gap을 `1.25rem` → `1.5rem`으로 살짝 늘려 여백에 숨 쉴 틈을 준다(과하게 벌리면 모바일에서 스크롤이 늘어나므로 소폭만 조정).

### 3-2. Sharing Thoughts — 아바타 + 액센트 바
1. 닉네임 문자열을 해시해서 고정 팔레트(웜 톤과 어울리는 6~8색: 테라코타 계열 몇 가지 + 대비를 위한 세이지그린·더스티블루·자두색 등) 중 하나를 결정론적으로 고르는 JS 헬퍼 `nickColor(nickname)` 추가. 같은 닉네임은 항상 같은 색이 나온다.
2. `.thought-card-head`를 `flex` 행으로 바꿔 좌측에 32px 원형 아바타(닉네임 첫 1~2글자, 대문자, `nickColor()` 배경색, 흰 글씨)를 추가하고 그 옆에 기존 닉네임+시간을 배치.
3. `.thought-card`에 `border-left: 3px solid <nickColor 결과>`를 인라인 스타일로 추가 — 같은 사용자의 카드는 아바타와 좌측 바 색이 항상 일치.
4. 댓글(`comment-item`/`comment-nick`)에는 이번에 적용하지 않는다 — 요청 범위가 "Sharing Thoughts 카드"였고, 댓글까지 확장하면 범위가 넓어진다. 필요하면 나중에 `nickColor()`를 재사용해서 쉽게 추가 가능하다는 점만 self-review에 남긴다.

### 3-3. Sources & Topics — 아코디언 + 아이콘/개수 + 톤 낮추기
1. 4개 카드의 `.card-head`를 클릭 가능한 토글 버튼으로 바꾸고, 각 헤더에 아이콘을 추가: ⚖ Legal Topics, 🏢 Business Topics, 📰 News Sources, ⏰ Archive Schedule.
2. 각 헤더 옆에 현재 상태 기반 개수를 표시: Legal Topics → 활성 토픽 수(예: "3/4") + 키워드 수, Business Topics → 활성 업종 수 + 추적 기업 수, News Sources → 등록된 URL 수, Archive Schedule → 등록된 시각 수. 값은 `S.topics`/`S.sectors`/`S.keywords`/`S.companies`/`S.urls`/`ALARM.times`를 그 자리에서 세어 렌더링 — 별도 상태 불필요.
3. 기본 열림/닫힘 상태(내 판단, 근거 포함): **Legal Topics·Business Topics는 기본 열림**(브리핑에 직접 영향을 주고 세션마다 조정할 가능성이 높음), **News Sources·Archive Schedule은 기본 닫힘 + 헤더 톤 낮춤**(한 번 설정하면 자주 안 건드리는 값). 열림/닫힘 상태는 `lexbrief_settings_open`에 저장해서 새로고침해도 유지.
4. 닫힌 카드의 헤더 텍스트/아이콘 색을 `var(--ink3)`로, 열린 카드는 `var(--ink)`로 — "자주 안 쓰는 카드는 톤을 낮춰준다"는 요청을 시각적으로 구현.
5. 새 CSS: `.settings-card-head`(클릭 가능, 화살표 아이콘 포함), `.settings-card-body.collapsed{display:none}`, 화살표 회전 트랜지션. 새 JS: `toggleSettingsCard(id)`, `settingsCardCounts()`(개수 계산 헬퍼), 초기 로드 시 `lexbrief_settings_open`을 읽어 상태 복원.

### 3-4. 시작 게이트(`#start-gate`) — 웰컴 히어로 + 닉네임 아바타 미리보기 + 로테이팅 명언

사용자 추가 요청: 닉네임 입력 화면이 지금은 설정 카드와 똑같은 흰 박스라서 "환영하는 느낌"이 없다. 3-2에서 만들 `nickColor()`를 재사용해서 개인화 요소를 추가하고, 짧은 법률/정의 관련 명언을 매번 다르게 보여준다.

1. `.start-gate-logo`를 감싸는 `.start-gate-hero` 블록 추가: `background:var(--accent)`, 흰 로고 마크(반전 배색: 배경 흰색, 글자 `--accent`), 태그라인, 그 아래 명언 텍스트까지 하나의 카드처럼 묶는다. 기존 두 개의 `.start-gate-card`(닉네임 폼, 최근 스토리 목록)는 그 아래 그대로 유지 — 구조를 크게 바꾸지 않고 위에 히어로 밴드만 얹는 형태라 리스크가 낮다.
2. `#gate-nickname` 입력 옆에 24px 원형 아바타(`#gate-nick-avatar`)를 추가하고, 이미 있는 `onGateNicknameInput()` 함수 안에 `nickColor(v)` 결과로 배경색과 이니셜을 채우는 코드를 추가한다(새 이벤트 리스너 불필요 — 기존 `oninput` 훅에 얹는다). 닉네임이 비었으면 아바타는 숨김.
3. 명언 데이터 `QUOTES = { en: [...], ko: [...], es: [...], fr: [...], zh: [...], ja: [...] }`(언어별 8개, 법률/정의 관련 짧은 인용구 + 저자)를 추가하고, `renderGateQuote()`가 `currentLang` 기준으로 배열에서 무작위로 하나를 뽑아 히어로 블록 안 `#gate-quote`에 렌더링한다. 페이지 최초 로드 시 한 번 호출하고, `applyLanguage()` 안에 있는 기존 훅 패턴(`window.renderTrendTopicPills && ...`)과 동일한 방식으로 `window.renderGateQuote && window.renderGateQuote();`를 추가해서 언어를 바꿀 때마다 그 언어의 명언 중 하나로 다시 뽑는다.
4. 이 명언들은 법률 자문이나 공식 인용이 아니라 순수 장식용 카피이므로, 번역은 "정확한 의미 전달" 수준이면 충분하고 학술적으로 공인된 번역본을 찾아야 하는 부담은 없다(self-review에 명시).

## 4. 기존 동작에 미치는 영향

- 색상 변경은 전역 CSS 변수 교체라서 로직에는 영향이 없다. 다만 시각적으로 앱 전체 룩이 바뀌므로, Daily Briefing·Compare·스토리 조사 결과 카드 등 색 변수에 의존하는 모든 화면이 함께 바뀐다(의도된 것).
- Sharing Thoughts 마크업 변경(아바타 추가)은 `thoughtCardHtml()`이 반환하는 HTML 구조가 바뀌므로, 이 함수를 호출하는 다른 곳(피드 렌더링, 실시간 patch 로직 — 2868번째 줄 근처의 "필드 단위 patch" 코드)이 새 구조를 깨지 않는지 확인이 필요하다. patch 로직이 `.thought-nick`/`.thought-text-${id}` 같은 특정 셀렉터만 건드린다면 아바타 추가는 안전하다.
- Sources & Topics 아코디언화는 기존 `toggleTopic`/`toggleSector`/`addKeyword`/`addCompany`/`addUrl`/`addAlarmTime` 등 입력 로직을 건드리지 않는다 — 카드가 접혀 있어도 그 안의 input/버튼 DOM은 그대로 존재하고 `display:none`만 토글되므로 로직 변경 없음.

## 5. 테스트 plan

- 로컬에서 `node server.js` 띄우고 브라우저로 직접 확인(이 변경은 순수 프론트엔드 시각 변경이라 코드 리뷰만으로는 부족 — 실제로 렌더링해서 봐야 한다):
  - 새 팔레트가 헤더·카드·버튼·칩 전체에 일관되게 적용됐는지, 특히 헤더의 흰 글씨가 새 `--accent` 배경 위에서 잘 읽히는지.
  - 언어 드롭다운을 열어서 옵션 글씨가 이제 잘 보이는지(이전 버그 수정 재확인).
  - Sharing Thoughts에서 서로 다른 닉네임 여러 개로 글을 올려 아바타 색이 닉네임마다 다르게, 그리고 같은 닉네임은 항상 같은 색으로 나오는지.
  - Sources & Topics에서 각 카드를 접고 펴보고, 개수 표시가 실제 상태(토픽 on/off, 등록된 회사 수 등)와 일치하는지, 새로고침 후에도 열림/닫힘 상태가 유지되는지.
  - 6개 언어 전환 후에도 아코디언 헤더 라벨과 개수 표시가 깨지지 않는지.
  - 모바일 너비(예: 375px)에서 늘어난 패딩/여백 때문에 가로 스크롤이 생기지 않는지.
- 이 변경 후 `run` skill로 실제 앱을 띄워서 화면을 확인하는 절차를 거친다(코드만 보고 "괜찮을 것"이라고 넘기지 않음).

## 6. 위험 / 엣지케이스

- **대비(contrast) 부족**: 새 `--accent`(#8B4A2C)가 헤더의 흰 글씨와 충분히 대비되는지 눈으로 재확인 필요 — 계산상 AA 기준을 넘지만 실제 렌더링에서 폰트가 얇으면(로고 텍스트 등) 체감 가독성이 다를 수 있다.
- **아바타 이니셜이 없는 경우**: 닉네임이 이모지나 특수문자로만 이뤄진 극단적 케이스 — 첫 글자를 그대로 쓰되, 빈 문자열이면 "?"로 대체하는 fallback을 넣는다.
- **아코디언 상태와 언어 전환 충돌 없음**: 개수 표시는 숫자 기반이라 언어와 무관하게 항상 정확하다.
- **실시간 patch 로직과의 충돌**: 3번 항목에서 언급한 대로, `thoughtCardHtml()` 구조 변경이 기존 patch 셀렉터를 깨지 않는지 구현 시점에 반드시 확인한다.

## 7. Self-review

- **베스트인지**: 색상 변경을 CSS 변수 레벨에서 처리해서 컴포넌트별 수정 없이 전체 룩을 바꾸는 게 가장 낮은 리스크·최소 코드 변경 경로다. 기능색(위험도 배지 등)은 그대로 둬서 정보 전달력을 해치지 않았다.
- **빠진 거 없는지**: 인터뷰에서 결정된 세 가지(색상 방향, Thoughts 아바타, Settings 아코디언+아이콘/개수+톤 낮추기)를 모두 반영했다. 언어 드롭다운 버그는 이미 별도로 수정 완료.
- **오버한 거 없는지**: 기능색(위험 배지, topic tag 6색)은 요청받지 않았으므로 건드리지 않았다. 댓글 UI에는 아바타를 확장하지 않았다(범위 밖). 아코디언 상태 저장에 새 백엔드나 Firestore 동기화를 추가하지 않고 기존 localStorage 패턴만 재사용했다.
- **테스트 충분한지**: 시각적 변경이라 자동 테스트가 의미 없는 영역이 많다 — 대신 `run` skill로 실제 렌더링 확인을 계획에 명시했다. 회귀 확인 대상(patch 로직)도 구체적으로 짚어뒀다.

## 8. 사용자 결정이 필요한 항목

없음 — 색상 방향, Thoughts 디자인, Settings 구조는 이미 인터뷰로 확정됐다. 기본 열림/닫힘 카드 배정(Legal/Business 열림, News/Archive 닫힘)은 내 판단이며 근거를 3-3 §3에 남겼다 — 구현 후 실제로 보고 마음에 안 들면 쉽게 뒤집을 수 있는 파라미터다.
