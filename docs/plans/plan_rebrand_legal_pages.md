# Plan: 사이트명 변경(LexBrief/Lexis Legal Intelligence → Lex.Almonds) + Terms/Privacy 페이지 + 상시 노출 푸터

## 0. 사용자 결정 사항 (인터뷰 완료)

- **새 이름**: `Lex.Almonds`. 후보로 제안한 StatuteIQ·JurisBrief 대신 사용자가 직접 정함. 웹 검색으로 "Lex" 단독은 실제 서비스(LGBTQ+ 소셜 앱)가 있지만 "Lex.Almonds" 전체 조합은 겹치는 게 없음을 확인 — 단, 이건 일반 웹 검색 수준 확인이고 정식 상표 검색은 아니므로 상업적으로 크게 키울 계획이면 나중에 변리사 확인을 권장.
- **GitHub 저장소 + Render 서비스명도 변경**: URL이 바뀌는 것을 감수하고 기술적 식별자까지 일관되게 맞추기로 함.
- **연락처 이메일**: `lexalmonds@gmail.com`.

## 1. 관련 코드 조사 결과

`LexBrief`/`Lexis Legal Intelligence`/`lexis-legal-intelligence` 문자열이 나오는 위치:

- `index.html`: `<title>`(4번째 줄), 게이트 히어로 타이틀(318번째 줄), 헤더 로고 텍스트(359번째 줄), 알람 알림 본문(835번째 줄).
- `server.js`: 스크래핑 시 보내는 `User-Agent` 헤더 3곳(`'Mozilla/5.0 (compatible; LexBrief/1.0)'`, `'LexBrief/1.0'`, `'LexBrief/1.0 contact@lexbrief.app'`) — 마지막 것은 실제 받지 않는 placeholder 이메일이었음.
- `package.json`의 `"name": "lexis-legal-intelligence"`.
- `render.yaml`의 `name: lexis-legal-intelligence`.
- `CLAUDE.md`(이 프로젝트의 project-level 지침 파일) 안에 "LexBrief 프로젝트"라는 표현.
- `docs/plans/spec_firebase_thoughts.md` — 과거에 완료된 기능의 영구 보존용 spec 문서. **여기는 손대지 않는다** — spec 문서는 그 시점의 의사결정을 기록하는 동결된 참고자료이므로, 나중에 브랜드가 바뀌었다고 과거 기록을 소급 수정하지 않는 게 이 프로젝트의 기존 관례(plan 파일은 구현 후 삭제, spec 파일은 영구 보존)와 맞음.
- `package-lock.json`, `node_modules/.package-lock.json` — `package.json`을 바꾸고 `npm install`을 다시 돌리면 자동으로 맞춰짐. 손으로 고칠 필요 없음.
- Firebase 프로젝트 ID(`legally-business`) — **바꾸지 않는다**. Firebase 프로젝트 ID는 생성 후 영구 불변이라 콘솔에서 표시 이름만 바꿀 수 있고, 실제로 바꾸려면 새 프로젝트를 만들어서 기존 사용자·글·설정 데이터를 전부 마이그레이션해야 한다 — 이번 작업 범위를 크게 벗어나고, 어차피 사용자에게는 노출되지 않는 내부 식별자라 실익도 없음.
- **검증 단계에서 대소문자 구분 없이 재검색해서 두 가지를 추가로 발견함 — 둘 다 절대 바꾸지 않는다:**
  - `index.html:2949`의 `const email = v + '@lexbrief.local';` — 닉네임을 Firebase Auth 이메일로 바꾸는 내부 로직이다. **이걸 바꾸면 지금까지 만들어진 모든 계정이 로그인 불가능해진다** — 기존 Firebase 계정은 이미 `{닉네임}@lexbrief.local`로 등록돼 있는데, 코드가 다른 도메인으로 이메일을 만들면 그 계정을 찾을 수 없어 "wrong password"류 오류만 뜨게 된다. 사용자에게 절대 노출되지 않는 내부 식별자이기도 해서 바꿀 이유도 없다.
  - `localStorage` 키 이름들(`lexbrief_urls`, `lexbrief_topics`, `lexbrief_sectors`, `lexbrief_keywords`, `lexbrief_companies`, `lexbrief_settings_open`, `lexbrief_nickname`, `lexbrief_lang` — `index.html` 전체에 20회 등장) — 브라우저에 로컬로 저장된 사용자 설정을 읽고 쓰는 키다. 계정을 잠그는 수준의 문제는 아니지만(Firestore 클라우드 동기화가 있어서 재로그인하면 복구됨), 바꾸면 기존 사용자가 다음 방문 때 로컬 설정이 일시적으로 기본값으로 보이는 혼란을 겪는다. 사용자에게 보이지 않는 내부 식별자이므로 브랜드명 교체 대상이 아니라고 판단 — 리스크만 있고 얻는 게 없음.

## 2. 범위

### 2-1. 브랜드명 교체
위 1번에서 찾은 `index.html`/`server.js`/`package.json`/`CLAUDE.md`의 모든 표기를 `Lex.Almonds`로 교체(User-Agent 문자열은 `Lex.Almonds/1.0` 형태 유지, contact 이메일은 `lexalmonds@gmail.com`으로 교체).

### 2-2. GitHub 저장소 + Render 서비스 이름 변경
- GitHub: `gh repo rename` 명령으로 `ssamline/lexis-legal-intelligence` → `ssamline/lex-almonds`로 변경(제가 `gh` CLI로 직접 실행 가능 — 이미 `repo` 권한으로 인증된 상태 확인함). 이후 로컬 git remote URL도 새 주소로 갱신.
- Render: **이 부분은 제가 대신 실행할 수 없다.** 조사해보니 `render.yaml`의 `name:` 값만 바꿔서 push하면 Render는 기존 서비스를 이름 변경하는 게 아니라 완전히 새로운(중복) 서비스로 취급한다 — 기존 서비스는 그대로 남고 별도의 서비스가 하나 더 생겨서 혼란과 리소스 낭비가 생김. 안전한 방법은 Render 대시보드에서 직접 서비스 이름을 바꾸는 것뿐이라, **사용자가 Render 대시보드에서 먼저 이름을 `lex-almonds`로 바꿔야** 한다. 그 확인을 받은 후에 `render.yaml`의 `name:` 값을 그에 맞춰 갱신해서 향후 Blueprint 동기화가 같은 서비스를 계속 가리키게 만든다.
- **순서 중요**: GitHub 저장소 이름 변경 → Render 대시보드가 여전히 올바른 저장소를 가리키는지 확인 → Render 서비스 이름을 사용자가 직접 변경 → `render.yaml` 갱신 → 나머지 변경사항과 함께 commit/push. 이 순서를 지키지 않으면 배포가 끊기거나 중복 서비스가 생길 위험이 있음.

### 2-3. Terms of Use / Privacy Policy 페이지 신설
- 새 파일 `terms.html`, `privacy.html`을 프로젝트 루트에 추가 — `server.js`가 이미 `express.static(path.join(__dirname))`로 루트 전체를 정적 서빙하고 있어서 별도 라우트 추가 없이 `/terms.html`, `/privacy.html`로 바로 접근 가능.
- 내용은 실제 앱 동작에 맞춰 작성(추측이나 과도한 보일러플레이트 지양):
  - 닉네임+비밀번호 기반 계정, Firebase(Google) 인증/데이터 저장 사용.
  - 사용자가 올리는 글(Sharing Thoughts)은 다른 사용자에게 공개됨.
  - AI(Anthropic Claude)가 생성하는 브리핑·분석·조사 결과는 **법률 자문이 아니며 반드시 원문·전문가 확인이 필요**하다는 고지 — 이미 앱 안에 있는 "AI-synthesized — verify with primary sources" 톤과 일치시킴.
  - 제3자 서비스 사용 고지: Firebase(Google), Anthropic API, OpenAI(TTS), CourtListener, SEC EDGAR, 사용자가 등록한 외부 뉴스 사이트.
  - 만 13세 미만 이용 제한 같은 표준적이고 낮은 리스크의 문구 포함.
  - 연락처: `lexalmonds@gmail.com`.
  - **문서 최상단에 "이 문서는 템플릿이며 법률 자문이 아니다, 실제 서비스로 키울 계획이면 변호사 검토를 권장한다"는 명시적 고지** — 제가 변호사가 아니고, 특히 "법률 인텔리전스" 서비스의 약관 자체가 부정확하면 아이러니하게 신뢰도에 타격이 크기 때문에 이 고지는 필수로 넣음.
  - 관할 법域/재판지 조항은 넣지 않음(사용자가 특정 법域을 지정하지 않았고, 제가 임의로 특정 국가/주법을 지정하는 건 실제 법적 효력이 있는 결정이라 제 임의 판단 영역이 아님) — 필요해지면 그때 변호사와 상의해서 추가하는 문구를 남김.
- 스타일은 기존 `.start-gate-card`/`.card` 패턴과 `report-style.css` 없이, `index.html`에 이미 있는 CSS 변수(`--ink`, `--surface`, `--accent` 등)를 그대로 재사용해서 룩앤필을 통일. 새 색상 정의 없음.

### 2-4. 상시 노출 푸터
- `#app-root` 안, `.main` 바로 아래(패널 콘텐츠 밖, 즉 모든 탭에서 공통으로 보이는 위치)에 얇은 푸터 바 추가: `© 2026 Lex.Almonds · Terms of Use · Privacy Policy`.
- **고정(fixed) 오버레이가 아니라 일반 푸터**로 만든다 — 매 탭(Daily Briefing/Personal Tool/Sharing Thoughts/Sources & Topics) 콘텐츠 하단에 항상 나타나서 어디서든 스크롤하면 도달 가능하게 함. 화면에 늘 떠 있는 고정 바로 만들면 특히 모바일에서 콘텐츠 영역을 영구적으로 잠식해서 지난 리프레시 작업에서 다듬은 여백 감각을 해치기 때문에, "항상 보이도록"은 고정 오버레이가 아니라 "어느 탭에 있든 항상 존재한다"는 뜻으로 해석함(내 판단 — 필요시 나중에 고정형으로 쉽게 바꿀 수 있음).
- 링크는 `<a href="/terms.html">`, `<a href="/privacy.html">`로 새 페이지를 그대로 연결(같은 탭에서 이동, 뒤로가기로 앱에 복귀 가능).
- 6개 언어 i18n에 맞춰 "Terms of Use"/"Privacy Policy" 라벨도 번역 키 추가(`footer.terms`, `footer.privacy`, `footer.copyright`).

## 3. 작업 순서

1. `index.html`의 브랜드명 4곳 교체.
2. `server.js`의 User-Agent 3곳 + contact 이메일 교체.
3. `package.json` `name` 필드 교체 → `npm install` 재실행으로 `package-lock.json` 갱신.
4. `CLAUDE.md`의 "LexBrief 프로젝트" 표현 교체.
5. `terms.html`, `privacy.html` 작성.
6. `index.html`에 푸터 마크업 + CSS + 6개 언어 i18n 키 추가.
7. 로컬에서 `node server.js` 띄우고 `/terms.html`, `/privacy.html` 접근 확인 + 푸터 링크 클릭 확인.
8. `gh repo rename ssamline/lexis-legal-intelligence lex-almonds` 실행 + 로컬 git remote URL 갱신.
9. 사용자에게 Render 대시보드에서 서비스 이름을 `lex-almonds`로 바꿔달라고 요청, 확인 받기.
10. `render.yaml`의 `name:`을 `lex-almonds`로 갱신.
11. 전체 변경 commit + push, Render 재배포 확인.

## 4. 기존 동작에 미치는 영향

- 브랜드명 교체는 표시 문자열만 바꾸는 것이라 로직에 영향 없음.
- GitHub 저장소 rename은 GitHub가 이전 URL을 자동으로 새 URL로 리다이렉트해주지만(웹훅 포함), Render의 GitHub 연결이 리다이렉트를 잘 따라가는지는 실제로 확인이 필요함 — 8번 작업 직후 Render 대시보드에서 저장소 연결 상태를 반드시 확인.
- Render 서비스 rename으로 `*.onrender.com` URL이 바뀌면, 커스텀 도메인을 연결해두지 않았다면 기존에 공유된 링크(북마크 등)가 깨짐 — 사용자가 이미 이 트레이드오프를 감수하기로 결정한 사항.
- `package-lock.json` 재생성은 다른 의존성 버전을 바꾸지 않고 이름만 갱신되므로 앱 동작에 영향 없음(확인 필요).

## 5. 테스트 plan

- 로컬 `node server.js`로 `/`, `/terms.html`, `/privacy.html` 전부 200 응답 확인.
- 브라우저에서 푸터의 두 링크를 실제로 클릭해서 문서가 열리는지, 뒤로가기로 앱에 복귀되는지 확인.
- 6개 언어 전환 후 푸터 라벨이 번역되는지 확인.
- `index.html`/`server.js`에 `LexBrief`/`Lexis` 잔여 문자열이 없는지 grep으로 재확인(대소문자 변형 포함).
- GitHub 저장소 rename 후 로컬 `git remote -v`가 새 URL을 가리키는지, `git push`가 정상 동작하는지 확인.
- Render 서비스 rename 후 새 URL로 실제 사이트가 뜨는지 사용자가 직접 확인(제가 접근할 수 없는 URL이므로 사용자 확인 필요).

## 6. 위험 / 엣지케이스

- **Render-GitHub 연결이 저장소 rename 후 끊길 가능성**: 위 4번에 명시. 끊기면 Render 대시보드에서 저장소를 재연결해야 함.
- **`render.yaml` name 필드를 대시보드 rename 전에 먼저 바꾸면 중복 서비스 생성**: 순서를 반드시 지킴(사용자 rename 확인 → 파일 수정).
- **이메일 주소 노출**: `lexalmonds@gmail.com`을 정적 HTML에 평문으로 넣으면 스팸 크롤러에 수집될 수 있음 — 이 정도 규모의 개인/팀 도구에서는 흔히 감수하는 수준이라 별도 난독화(예: JS로 조립)는 넣지 않음(오버엔지니어링 판단).
- **Terms/Privacy 문서의 법적 유효성**: 명시적으로 "템플릿, 법률 자문 아님" 고지를 넣어서 리스크를 낮춤. 실제 법적 검토는 범위 밖.

## 7. Self-review

- **베스트인지**: 브랜드명 교체는 문자열 치환 수준이라 리스크가 낮고, Render 부분만 사용자 개입이 필요한 이유를 조사(웹 검색)로 근거를 갖고 판단했다 — 추측으로 render.yaml만 고치고 끝냈다면 나중에 중복 서비스가 생기는 사고로 이어질 뻔했다.
- **빠진 거 없는지**: 사용자가 명시한 세 가지(이름, 저장소/Render 이름, 연락처 이메일)를 모두 반영했고, Firebase 프로젝트 ID처럼 기술적으로 바꿀 수 없는 부분은 이유를 명시해서 범위에서 제외했다.
- **오버한 거 없는지**: 관할 법域 조항이나 이메일 난독화처럼 요청받지 않았고 실익이 애매한 부분은 추가하지 않았다. `spec_firebase_thoughts.md` 같은 과거 spec 문서는 소급 수정하지 않았다.
