# Spec — Firebase 친구 의견/질문 게시판 (LexBrief)

상태: 1~11번(닉네임 게이트 + 친구 의견/질문 게시판 + 작성자 본인
수정·삭제) 구현 완료, Playwright 헤드리스 브라우저로 라이브 Firestore에
대고 전체 흐름(글 작성→수정→댓글→댓글 삭제→글 삭제, 타인 글 보안 규칙
거부) 검증 완료. 12번(닉네임 중복 방지 — 비밀번호 클레임)은 plan 작성
완료, 구현 대기. 메이저 기능(외부 서비스 신규 통합 + 신규 데이터 모델 +
신규 화면)이라 `spec_` 문서로 영구 보존한다 (구현 후에도 삭제하지 않음).

**남은 사용자 액션** — Firebase 콘솔 → Firestore Database → "규칙" 탭에
이 저장소의 `firestore.rules` 내용을 붙여넣고 게시해야 실제 쓰기 보안이
적용된다(현재는 프로젝트 기본 규칙이 적용된 상태). 규칙을 붙여넣기 전까지는
Firestore 콘솔의 기본 모드에 따라 더 느슨하거나(테스트 모드) 더 엄격하게
(프로덕션 모드, 쓰기 전체 차단) 동작할 수 있다.

## 1. 요청 요약

`index.html` 하나로 이루어진 정적 프론트엔드("LexBrief")에 Firebase Firestore를
붙여서 친구들끼리 의견·질문을 남기고 서로 댓글을 달 수 있는 게시판을 추가한다.
앱을 열면 가장 먼저 닉네임 입력 화면(시작 화면)이 뜨고, 최근 의견/질문 5개가
같이 보인다. 닉네임을 입력해야 "시작하기" 버튼이 눌리고, 한 번 입력한 닉네임은
다음에 열었을 때 자동으로 채워져 있어야 한다. 기존 "Your Thoughts" 페이지에 글
작성 폼을 추가하고, 여기서 글을 쓰면 자동 저장되면서 시작 화면의 최근 5개 목록도
그 다음 실행 때 반영되어야 한다.

## 2. 현재 코드베이스 파악 결과

앱은 build 단계 없는 단일 `index.html`(1,329줄, `<style>` + 마크업 +
`<script>` 인라인)과 Express 서버 `server.js`로 구성되어 있다. 인증/로그인
시스템은 없고, 사용자 설정(선택한 뉴스 소스, 토픽, 알람 등)은 전부
`localStorage`에 `lexbrief_*` / `lb_*` 키로 저장되는 방식이다 (`index.html:494-558`
부근). 최상위 nav는 `📰 Daily Briefing` / `💬 Your Thoughts` / `⚙ Sources & Topics`
세 개이고(`index.html:236-238`), `showPanel()` 함수(`index.html:599-606`)가 단순
class 토글로 패널을 전환한다.

`Your Thoughts` 패널(`index.html:275-354`, 주석상 "RESEARCH HUB")은 현재
Archive / Search Stories / Legal Q&A / Compare 네 개의 서브탭으로 구성된 리서치
도구 모음이고, "개인 의견/질문을 자유롭게 남기는" 기능은 아직 없다. 서브탭
전환은 `showSubPanel()`(`index.html:899` 부근)이 담당한다. 이번 기능은 여기에
새 서브탭을 하나 추가하는 형태로 들어간다.

Firebase, 로그인, 사용자 식별 관련 코드는 프로젝트 전체에 전혀 없다 (grep 결과
0건) — 완전히 새로 붙이는 통합이다. `server.js`는 뉴스/판례/SEC 조회와 Claude
API 프록시만 담당하며, 이번 기능은 클라이언트에서 Firestore와 직접 통신하므로
서버 쪽 변경은 없다.

## 3. 외부 연동 확인 (Firebase 공식 문서 기준)

Firebase 공식 문서(`firebase.google.com/docs/web/setup`,
`firebase.google.com/docs/firestore/quickstart`) 기준으로 현재 권장 방식은
modular Web SDK이며, 빌드 도구 없이 쓸 때는 CDN에서 ES 모듈로 바로 import한다.
현재 CDN에 게시된 최신 버전은 **12.16.0**이다.

```html
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
  import {
    getFirestore, collection, addDoc, getDocs, doc, updateDoc, increment,
    query, orderBy, limit, startAfter, serverTimestamp
  } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
</script>
```

Storage나 Analytics는 이번 기능에 필요 없으므로 `firebase-storage.js`,
`firebase-analytics.js`는 import하지 않는다.

### firebaseConfig 형식 (사용자 질문에 대한 답)

Firebase 콘솔 → 프로젝트 설정(⚙) → 일반 탭 → "내 앱" → 웹 앱(`</>`) 등록 →
"SDK 설정 및 구성" → "구성(Config)" 라디오 버튼을 누르면 아래와 같은 객체가
그대로 나온다. 이 객체를 통째로 복사해서 붙여넣어 주면 된다.

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456",
  measurementId: "G-XXXXXXX"   // Analytics 켠 경우에만 존재, 없어도 무방
};
```

이 값들은 서버 비밀키가 아니라 "이 웹앱이 어느 Firebase 프로젝트에 붙는지"를
가리키는 공개 식별자라서(Firebase 공식 문서에서도 명시) `.env`가 아니라
`index.html`에 그대로 박아 넣어도 안전하다 — 실제 접근 제어는 아래 4-3의
Firestore 보안 규칙이 담당한다. `measurementId`는 없으면 그 줄을 통째로
지우고 붙여넣어도 된다.

아직 Firebase 프로젝트가 없다면 사용자가 직접 해야 하는 절차는 다음과
같다(콘솔 GUI 액션이라 내가 대신 못 함): firebase.google.com → 콘솔 →
"프로젝트 추가"로 새 프로젝트 생성 → 왼쪽 메뉴 "Firestore Database" →
"데이터베이스 만들기" → 리전 선택(예: `asia-northeast3` 서울) → 처음엔
"테스트 모드"든 "프로덕션 모드"든 상관없음(아래 4-3 규칙을 그대로 덮어쓸
것이므로) → 프로젝트 설정에서 웹 앱 등록 후 위 `firebaseConfig` 복사.

## 4. 데이터 모델 (Firestore)

### 4-1. 컬렉션 구조

```
thoughts (컬렉션)
  {thoughtId} (문서)
    nickname:     string   (작성자 닉네임, 1~20자)
    text:         string   (의견/질문 본문, 1~500자)
    createdAt:    Timestamp (serverTimestamp())
    commentCount: number   (댓글 개수, 생성 시 0으로 시작, 댓글 달릴 때마다 +1)

    comments (서브컬렉션)
      {commentId} (문서)
        nickname:  string   (댓글 작성자 닉네임)
        text:      string   (댓글 본문, 1~500자)
        createdAt: Timestamp (serverTimestamp())
```

별도의 `users` 컬렉션이나 로그인 계정은 만들지 않는다. 닉네임은 그냥 자유
입력 텍스트이고 중복·소유권 검증이 없다 — "친구들끼리" 캐주얼하게 쓰는
용도라 계정 시스템을 새로 만드는 건 이번 요청 범위를 넘는 과잉 설계라고
판단해서 뺐다. 이 점은 6번 리스크 섹션에 다시 정리했다.

### 4-2. 조회 패턴

시작 화면 최근 5개: `query(collection(db,'thoughts'), orderBy('createdAt','desc'), limit(5))`.

`Your Thoughts → 내 생각` 서브탭 전체 피드: 동일 컬렉션을 `limit(50)`로 최초
로드하고, "더 보기" 버튼을 누르면 마지막 문서를 커서로 `startAfter(lastDoc)`
+ `limit(50)`로 다음 페이지를 이어 붙인다. 정렬 필드가 `createdAt` 하나뿐이라
복합 색인(composite index)은 필요 없다.

댓글: 카드의 "댓글 N개" 토글을 눌렀을 때만
`getDocs(query(collection(db,'thoughts',id,'comments'), orderBy('createdAt','asc')))`
로 가져온다 (목록 진입 시 모든 카드의 댓글을 미리 불러오지 않음 — 불필요한
읽기 비용 방지).

### 4-3. Firestore 보안 규칙

로그인이 없으므로 "본인 글만 수정 가능" 같은 진짜 소유권 검증은 불가능하다.
대신 다음 규칙으로 (a) 읽기는 전체 공개 (b) 쓰기는 생성만 허용하고 수정·삭제는
막아서 — 누가 남의 글을 고치거나 지우는 것 자체를 원천 차단 (c) 필드 타입과
길이를 강제해서 스팸성 대용량 데이터 주입을 막는다.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /thoughts/{thoughtId} {
      allow read: if true;
      allow create: if request.resource.data.keys().hasOnly(['nickname','text','createdAt','commentCount'])
                    && request.resource.data.nickname is string
                    && request.resource.data.nickname.size() > 0
                    && request.resource.data.nickname.size() <= 20
                    && request.resource.data.text is string
                    && request.resource.data.text.size() > 0
                    && request.resource.data.text.size() <= 500
                    && request.resource.data.commentCount == 0;
      allow update: if request.resource.data.diff(resource.data).affectedKeys().hasOnly(['commentCount'])
                    && request.resource.data.commentCount == resource.data.commentCount + 1;
      allow delete: if false;

      match /comments/{commentId} {
        allow read: if true;
        allow create: if request.resource.data.keys().hasOnly(['nickname','text','createdAt'])
                      && request.resource.data.nickname is string
                      && request.resource.data.nickname.size() > 0
                      && request.resource.data.nickname.size() <= 20
                      && request.resource.data.text is string
                      && request.resource.data.text.size() > 0
                      && request.resource.data.text.size() <= 500;
        allow update: if false;
        allow delete: if false;
      }
    }
  }
}
```

이 규칙은 Firebase 콘솔 → Firestore Database → "규칙" 탭에 사용자가 직접
붙여넣고 "게시" 버튼을 눌러야 적용된다(콘솔 GUI 액션). 파일로도
`firestore.rules`에 같이 커밋해서 히스토리에 남긴다.

## 5. UI/UX 설계

### 5-1. 시작 화면 (신규)

`<div class="app">`(`index.html:222`) 진입 지점에 그 앞에 전체 화면 게이트
`#start-gate`를 추가한다. 페이지 로드 시 `#start-gate`가 보이고 `.app`은
숨겨진 상태로 시작한다. 사용자 흐름은 다음과 같다.

- 로드 즉시 `localStorage.getItem('lexbrief_nickname')` 값이 있으면 닉네임
  입력창에 미리 채워 넣는다. 값이 있어도 게이트는 그대로 뜬다 — 매번 확인
  후 눌러서 들어가는 흐름이고, 자동으로 건너뛰지 않는다(요청 문구 그대로).
- 동시에 Firestore에서 최근 5개 글을 불러와 게이트 하단에 카드 목록으로
  보여준다. 로딩 중엔 "최근 의견을 불러오는 중…" 힌트, 글이 하나도 없으면
  "아직 등록된 의견이 없어요."
- 닉네임 입력창에 공백 아닌 글자가 1자 이상 있어야 "시작하기" 버튼이
  활성화된다(빈 값이거나 공백만 있으면 버튼 `disabled`).
- "시작하기" 클릭 시: 닉네임을 trim해서 `S.nickname`에 저장 +
  `localStorage.setItem('lexbrief_nickname', nickname)` + `#start-gate` 숨김
  + `.app` 표시.
- 시작 화면의 최근 5개 카드는 읽기 전용 미리보기다(클릭해서 펼치거나 거기서
  바로 댓글을 달지는 않음) — 닉네임을 넣고 "시작하기"를 눌러야 상호작용이
  가능하다는 요청 취지에 맞춘 것이다. 실제로 글을 읽고 댓글을 달고 싶으면
  앱에 들어가서 `Your Thoughts` 탭으로 이동한다.

### 5-2. `Your Thoughts` 서브탭 추가

기존 서브탭 4개(Archive / Search Stories / Legal Q&A / Compare) 앞에 새
서브탭 `📝 내 생각`을 추가하고, 이 패널이 `Your Thoughts` 진입 시 기본으로
보이는 탭이 되게 한다("Your Thoughts"라는 이름에 가장 부합하는 콘텐츠이므로).
기존 4개 탭은 순서만 뒤로 밀리고 동작은 그대로 둔다.

새 서브패널 구성:

- 상단 작성 카드 — textarea(`의견이나 질문을 남겨보세요…`) + `게시` 버튼.
  작성자 닉네임은 시작 화면에서 이미 받은 `S.nickname`을 그대로 쓰고, 여기서
  다시 입력받지 않는다. 게시 성공 시 textarea를 비우고 목록 맨 위에 새 카드를
  바로 추가한다(다시 fetch하지 않고 낙관적으로 반영, 실패 시 에러 토스트).
- 피드 목록 — 카드마다 닉네임, 상대 시간("3분 전" 등), 본문, `댓글 N개`
  토글 버튼. 토글을 열면 댓글 목록 + 댓글 입력창이 카드 안에 펼쳐진다. 댓글
  등록 시 `commentCount`를 +1 갱신하고 목록에 즉시 추가한다.
- 하단 `더 보기` 버튼 — 더 불러올 문서가 없으면 버튼을 숨긴다.

### 5-3. 신규 CSS

기존 디자인 토큰(`--accent`, `--ink`, `--rule`, `Georgia serif` 본문 /
`Arial sans-serif` 라벨 조합)을 그대로 따른다. 새 클래스: `.start-gate`,
`.start-gate-card`, `.start-recent-list`, `.start-recent-item`,
`.thought-compose`, `.thought-card`, `.thought-comments`, `.comment-item`.
색상·라운드·그림자는 기존 `.card`/`.chip`/`.btn-primary`와 동일 톤을 재사용한다.

## 6. 구현 단계 (파일별 변경 범위)

전부 `index.html` 한 파일 안에서 처리된다(빌드 단계가 없는 정적 페이지라
별도 모듈 파일을 만들 이유가 없음). 새로 추가할 파일은 `firestore.rules`
(4-3 규칙 보관용, Firestore 콘솔에는 별도로 붙여넣어야 함) 뿐이다.

1. `<style>` 블록 끝에 5-3의 신규 CSS 클래스 추가.
2. `<body>` 최상단, `<div class="app">` 바로 앞에 `#start-gate` 마크업 추가하고
   `.app`에 `style="display:none"`(또는 클래스)을 기본으로 건다.
3. `Your Thoughts` 패널의 서브탭 목록(`index.html:280-285`)에 `내 생각` 버튼을
   맨 앞에 추가하고, `sub-panel`(`index.html:288` 이하)에 해당 마크업 추가.
   `showSubPanel` 기본 활성 탭을 `thoughts-mine`으로 변경.
4. 기존 `<script>` 블록 끝, `</body>` 직전에 `<script type="module">` 블록을
   새로 추가해서 Firebase 초기화 + 3번의 함수들을 정의한다. 인라인
   `onclick="..."`에서 호출해야 하는 함수(`enterApp`, `postThought`,
   `toggleComments`, `postComment`, `loadMoreThoughts`)는 `window.fn = fn`
   형태로 명시적으로 전역에 노출한다 — ES 모듈 스크립트는 top-level 선언이
   자동으로 `window`에 붙지 않기 때문에, 기존 코드베이스가 쓰는 인라인
   `onclick` 패턴을 그대로 유지하려면 이 처리가 반드시 필요하다.
5. 사용자가 붙여넣어 줄 `firebaseConfig` 객체를 4번 스크립트 상단에 그대로
   삽입.
6. `firestore.rules` 파일 생성(4-3 내용), 사용자가 Firebase 콘솔에 직접
   붙여넣도록 안내.

## 7. 테스트 plan

- 로컬에서 `npm start`로 서버 띄우고 브라우저로 접속해 시작 화면이 뜨는지,
  닉네임 없이는 "시작하기"가 비활성인지 확인.
- 닉네임 입력 후 시작 → 앱 진입 → 새로고침 → 닉네임 입력창에 방금 입력한
  이름이 미리 채워지는지 확인.
- `Your Thoughts → 내 생각`에서 글 작성 → Firestore 콘솔에서 문서가
  실제로 생성됐는지 확인 → 새로고침 후 시작 화면 최근 5개에 반영되는지 확인.
- 두 개의 서로 다른 브라우저(또는 시크릿 창)로 서로 다른 닉네임을 넣고,
  한쪽에서 쓴 글에 다른 쪽에서 댓글을 달아 `commentCount`가 올라가고 양쪽
  다 댓글이 보이는지 확인.
- 500자 초과 텍스트, 빈 텍스트, 20자 초과 닉네임으로 규칙이 실제로 막는지
  Firestore 콘솔 "규칙 시뮬레이터" 또는 브라우저 콘솔에서 직접 확인.
- 글이 51개 이상 쌓인 상태를 가정해 "더 보기"가 정상적으로 다음 페이지를
  불러오는지 확인(초반엔 테스트 데이터를 스크립트로 여러 개 넣어서 검증).

## 8. 리스크 / 엣지케이스

닉네임 기반 식별은 로그인이 없어 다른 사람이 같은 닉네임을 그대로 써서
누군가로 "위장"해서 글을 쓰는 걸 막지 못한다. 친구들끼리만 쓰는 캐주얼한
게시판이라는 요청 맥락에서는 허용 가능한 트레이드오프라고 보고 이번 범위에
포함하지 않았지만, 나중에 문제가 되면 Firebase Anonymous Auth 정도를 얹어
디바이스별 고정 ID를 부여하는 식으로 확장할 수 있다.

쓰기 권한 자체가 공개되어 있어서(닉네임/글자수 검증만 있고 인증은 없음) 이론
상 누구든 API 요청을 직접 보내 스팸을 넣을 수 있다. 이 부분은 4-3 규칙의
길이 제한과 "생성만 허용, 수정·삭제 불가" 정책으로 최소한의 방어만 해두었고,
실제로 스팸이 발생하면 Firebase App Check(도메인 검증)를 추가로 얹는 걸
후속 작업으로 권장한다 — 지금 시점에 미리 만들진 않는다(요청 범위 밖).

댓글이 하나도 없는 글의 "댓글 N개" 버튼은 `댓글 0개`로 표시하고 눌러도 빈
목록 + 입력창만 뜨게 한다(별도 빈 상태 문구 불필요할 만큼 간단한 케이스).

Firestore 무료 등급(Spark 플랜) 한도 안에서 친구들 소규모 사용은 충분히
커버되므로 별도 과금 관련 안내는 필요 없다고 판단했다.

## 9. Self-review

**베스트 plan인지** — 빌드 도구가 없는 단일 HTML 페이지라는 제약을 그대로
받아들여서 CDN 기반 modular Firebase SDK로 접근한 게 이 프로젝트 구조에
가장 자연스럽다. 별도 백엔드 API 레이어를 만들지 않고 클라이언트에서 직접
Firestore와 통신하는 방식도, 이번 기능이 단순 CRUD 게시판이라 서버를 거칠
이유가 없다는 점에서 적절하다.

**빠진 게 있는지** — 실시간 업데이트(다른 사람이 글을 쓰면 내 화면에 새로고침
없이 바로 뜨는 것)는 넣지 않았다. 요청 문구("자동으로 저장되고 최근5개가
시작 화면에 업데이트 되게")는 "다음에 열었을 때 반영"으로 읽는 게 자연스럽고,
시작 화면 자체가 앱을 새로 열 때만 보이는 게이트라 `onSnapshot` 실시간 리스너
없이도 요구사항을 만족한다. 필요해지면 이후 후속 작업으로 쉽게 추가 가능한
지점만 남겨뒀다.

**오버한 게 있는지** — 로그인 시스템, 글 수정/삭제, 좋아요, 알림 등은 요청에
없어서 만들지 않았다. `commentCount` 비정규화 카운터 하나만 추가했는데, 이건
피드에서 댓글 개수를 보여주려면 서브컬렉션을 매번 읽어야 하는 비용을 피하기
위한 최소한의 장치라 과잉이 아니라고 판단했다.

## 10. 사용자 결정 필요 항목

설계상 트레이드오프가 팽팽한 지점(진짜 취향·도메인 판단이 필요한 항목)은
없다고 판단해서 — 위 8번에서 이미 근거를 밝힌 대로 — 별도 인터뷰 없이
바로 이 spec에 결정을 반영했다. 사용자가 실제로 해야 하는 액션은 두 가지뿐이다.

- Firebase 콘솔에서 프로젝트 + Firestore 데이터베이스를 만들고 (3번 섹션
  참고) `firebaseConfig` 객체를 채팅에 붙여넣어 주는 것.
- 이 spec의 5번(UI 흐름)과 8번(리스크, 특히 "닉네임 위장 방지 안 함")을 보고
  방향이 맞는지 확인해 주는 것 — 다르게 가고 싶은 지점이 있으면 여기서
  얘기해 주면 반영해서 진행한다.

## 11. 추가 기능 — 작성자 본인 수정·삭제 (Anonymous Auth)

1번 구현이 끝난 뒤 사용자가 추가로 요청한 기능이다. "글/댓글을 올린 사람이
본인 글을 나중에 수정하거나 삭제할 수 있게 해달라"는 요청이고, 대상은
의견/질문 글과 댓글 둘 다이다.

### 11-1. 왜 Anonymous Auth가 필요한가

지금까지는 닉네임이 그냥 자유 입력 텍스트라 "이 글이 진짜 이 사람이 쓴 글"
이라는 걸 서버(Firestore 규칙) 쪽에서 증명할 방법이 없었다. 수정·삭제
권한을 안전하게 걸려면 최소한 "이 브라우저가 그때 그 브라우저와 같다"는
걸 증명하는 식별자가 필요한데, Firebase Auth 없이는 이걸 위조 불가능하게
만들 수 없다(로컬스토리지에 아무 값이나 넣고 그게 자기 글이라고 우기는
클라이언트를 막을 수 없음). `Firebase Anonymous Authentication`을 쓰면
사용자가 로그인 화면을 보거나 뭔가 입력할 필요 없이, 앱을 처음 열 때
조용히 백그라운드에서 고유 `uid`가 발급되고 이후 재방문 시에도 브라우저에
저장된 세션으로 같은 `uid`가 유지된다. 이 `uid`는 Firestore 보안 규칙에서
`request.auth.uid`로 신뢰성 있게 참조할 수 있는 유일한 값이라, 닉네임과는
별개로 "소유권 증명"의 근거로 쓴다(닉네임은 여전히 표시용 이름일 뿐, 로그인
계정이 되는 게 아니다).

트레이드오프는 이 `uid`가 브라우저(정확히는 브라우저의 로컬 저장소)에
묶인다는 것이다. 브라우저 데이터를 지우거나 다른 기기·시크릿 창으로 들어가면
새 익명 계정이 발급되면서 예전 글에 대한 수정·삭제 권한을 잃는다. 계정
시스템을 새로 만들지 않는 이상 피할 수 없는 한계이고, 캐주얼한 친구
게시판이라는 맥락에서 감수할 만하다고 판단했다(8번 리스크 섹션과 같은
종류의 트레이드오프).

공식 문서(`firebase.google.com/docs/auth/web/anonymous-auth`) 기준
확인 사항은 다음과 같다.

- 콘솔에서 사전 활성화가 필수다: Firebase 콘솔 → **Authentication**
  (왼쪽 메뉴에 없으면 "시작하기"를 눌러 처음 활성화) → **Sign-in method**
  탭 → **Anonymous** 항목 활성화 → 저장. 이 단계를 건너뛰면
  `signInAnonymously()` 호출이 `auth/admin-restricted-operation` 류
  에러로 실패한다.
- modular SDK 사용법은 기존 Firestore 통합과 같은 패턴이다.
  `getAuth(app)`으로 auth 인스턴스를 얻고, `signInAnonymously(auth)`로
  로그인하고, `onAuthStateChanged(auth, user => …)`로 `user.uid`를
  받는다. CDN 경로는 기존 `firebase-app.js`/`firebase-firestore.js`와
  같은 버전 규칙을 따라 `https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js`.

### 11-2. 데이터 모델 변경

`thoughts/{id}`와 `thoughts/{id}/comments/{id}` 문서 스키마에 필드 두 개를
추가한다.

- `authorUid: string` — 작성 시점의 `auth.currentUser.uid`. 생성 후에는
  절대 바뀌지 않는다(소유권 판별의 유일한 근거이므로 규칙에서 수정 자체를
  차단한다).
- `editedAt: Timestamp | null` — 수정한 적이 있으면 `serverTimestamp()`로
  채워진다. 카드에 "(수정됨)" 표시를 하기 위한 용도이고, 없으면 필드 자체가
  없는 상태로 둔다(생성 시엔 아예 넣지 않고, 최초 수정 시 처음 추가).

기존에(1번 구현 테스트 중) 생성된 문서가 있다면 `authorUid`가 없는 상태로
남는다. 마이그레이션은 하지 않는다 — 그런 문서는 그냥 "누구도 수정·삭제
못 하는 글"로 취급되고, 화면에서도 수정·삭제 버튼이 자연스럽게 안 뜬다(11-4
참고). 별도 처리 없이 놔둬도 사용성에 문제가 없는 엣지케이스라 마이그레이션
스크립트까지는 만들지 않는다.

`commentCount`는 기존에는 댓글 추가시에만 +1 했는데, 이제 댓글 삭제가
생기므로 삭제 시 -1도 발생한다. 처음엔 이걸 `runTransaction`으로 묶으려고
했는데, 검증 과정에서 불필요한 복잡도라고 판단해서 뺐다 — `increment()`는
Firestore가 서버에서 원자적으로 처리하는 값이라 클라이언트가 현재 값을
먼저 읽을 필요가 없고, "0 미만으로 못 내려간다"는 제약도 클라이언트 읽기가
아니라 11-3 규칙의 `resource.data.commentCount`(커밋 시점의 서버측 실제
값) 기준으로 검사되기 때문에 트랜잭션 없이도 동일한 안전성이 보장된다.
그래서 기존 1번 구현의 `postComment`(`addDoc` + `updateDoc(increment(1))`
순차 호출)와 완전히 대칭인 패턴으로 `deleteComment`도 `deleteDoc` +
`updateDoc(increment(-1))` 순차 호출로 구현한다 — 이미 검증 통과한 기존
패턴을 그대로 재사용하는 셈이라 트랜잭션보다 단순하고 신뢰도도 같다.

이 둘을 순차 호출로 분리하면 두 번째 호출(`commentCount` 갱신)만 실패하는
경우가 생길 수 있다(예: 댓글은 지워졌는데 카운트 갱신 요청만 네트워크
문제로 실패). 이때는 두 호출을 각각 별도 `try/catch`로 감싸서, 댓글 삭제
자체는 성공한 대로 화면에 반영하고 카운트 갱신 실패는 조용히 무시한다 —
`commentCount`는 다음 전체 새로고침 때 실제 댓글 수와 다시 맞아떨어지는
건 아니고(파생값이 아니라 별도 저장 필드라서) 오차가 남을 수 있지만, 친구
게시판 규모에서 극히 드문 실패 케이스까지 완벽히 맞추려고 추가 인프라를
넣는 건 과하다고 판단했다. 또한 `commentCount` 갱신 대상인 부모
`thoughts/{thoughtId}` 문서가 그사이 작성자 본인에 의해 삭제됐을 수도
있다 — 이 경우 `updateDoc`이 not-found로 실패하는데, 이것도 같은
`catch`에서 조용히 무시하면 된다(댓글 삭제 자체의 성공 여부와는 무관).

글(`thoughts`) 삭제 시 그 글의 `comments` 서브컬렉션은 같이 지우지
않는다. Firestore는 상위 문서를 지워도 서브컬렉션을 자동으로 지우지
않고, 클라이언트에서 서브컬렉션 전체를 순회 삭제하려면 별도 로직이
필요한데 — 이미 화면에서 안 보이는(부모가 사라졌으니 도달 경로가 없는)
데이터라 실사용에 지장이 없고, 이 정도 규모의 친구 게시판에서 안 쓰는
문서 몇 개가 Firestore에 남는 건 무시할 만한 비용이다. Cloud Functions로
cascade delete를 만드는 건 이번 범위에서는 과한 인프라라고 판단해 뺐다.

### 11-3. Firestore 보안 규칙 변경 (`firestore.rules` 갱신)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /thoughts/{thoughtId} {
      allow read: if true;

      allow create: if request.auth != null
                    && request.resource.data.keys().hasOnly(['nickname','text','createdAt','commentCount','authorUid'])
                    && request.resource.data.authorUid == request.auth.uid
                    && request.resource.data.nickname is string
                    && request.resource.data.nickname.size() > 0
                    && request.resource.data.nickname.size() <= 20
                    && request.resource.data.text is string
                    && request.resource.data.text.size() > 0
                    && request.resource.data.text.size() <= 500
                    && request.resource.data.commentCount == 0;

      // 댓글 수 증감(+-1, 0 미만 불가) — 댓글을 달거나 지운 누구나 호출
      allow update: if request.auth != null
                    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['commentCount'])
                    && request.resource.data.commentCount >= 0
                    && (request.resource.data.commentCount == resource.data.commentCount + 1
                        || request.resource.data.commentCount == resource.data.commentCount - 1);

      // 본문 수정 — 작성자 본인만, authorUid/nickname/createdAt은 불변
      allow update: if request.auth != null
                    && request.auth.uid == resource.data.authorUid
                    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['text','editedAt'])
                    && request.resource.data.text is string
                    && request.resource.data.text.size() > 0
                    && request.resource.data.text.size() <= 500;

      allow delete: if request.auth != null && request.auth.uid == resource.data.authorUid;

      match /comments/{commentId} {
        allow read: if true;

        allow create: if request.auth != null
                      && request.resource.data.keys().hasOnly(['nickname','text','createdAt','authorUid'])
                      && request.resource.data.authorUid == request.auth.uid
                      && request.resource.data.nickname is string
                      && request.resource.data.nickname.size() > 0
                      && request.resource.data.nickname.size() <= 20
                      && request.resource.data.text is string
                      && request.resource.data.text.size() > 0
                      && request.resource.data.text.size() <= 500;

        allow update: if request.auth != null
                      && request.auth.uid == resource.data.authorUid
                      && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['text','editedAt'])
                      && request.resource.data.text is string
                      && request.resource.data.text.size() > 0
                      && request.resource.data.text.size() <= 500;

        allow delete: if request.auth != null && request.auth.uid == resource.data.authorUid;
      }
    }
  }
}
```

`allow update`를 두 블록으로 나눈 이유는 "누구나 할 수 있는 업데이트(댓글 수
증감)"와 "작성자만 할 수 있는 업데이트(본문 수정)"의 조건이 서로 다르기
때문이다 — Firestore 규칙은 같은 동작(`update`)에 대해 여러 `allow` 블록을
쓰면 그중 하나만 만족해도 허용되므로 이렇게 분리하는 게 자연스럽다.

### 11-4. UI 변경

각 `.thought-card`와 `.comment-item`에 소유자 판별 로직을 추가한다 —
`t.authorUid && myUid && t.authorUid === myUid`일 때만 "수정"/"삭제" 버튼을
렌더링한다. `myUid`(로그인 미완료 시 `undefined`)와 `t.authorUid`(과거
문서라 없으면 `undefined`)가 둘 다 비어서 `undefined === undefined`로
false-positive 소유권 판정이 나지 않도록 두 값 모두 존재 확인을 먼저
한다 — 이 가드가 없으면 로그인 완료 전 잠깐, 혹은 레거시 문서에 대해
아무나 수정·삭제 버튼을 보게 되는 버그가 생긴다.

- **수정** — 버튼을 누르면 `.thought-text`(또는 `.comment-text`) 자리가
  기존 텍스트를 채운 `<textarea>` + "저장"/"취소" 버튼으로 바뀐다(기존 아카이브
  카드의 펼치기/접기 토글과 같은 "그 자리에서 바꿔치기" 패턴). 저장을 누르면
  `updateDoc`으로 `text`와 `editedAt: serverTimestamp()`를 갱신하고, 성공하면
  다시 일반 텍스트 모드로 돌아가면서 시간 옆에 "(수정됨)" 라벨을 붙인다.
- **삭제** — 버튼을 누르면 네이티브 `confirm('정말 삭제할까요?')`로 한 번
  확인한다(이 앱에 커스텀 확인 모달이 따로 없어서, 기존 수준에 맞춰 브라우저
  기본 confirm을 그대로 쓴다). 확인하면 `deleteDoc`을 호출하고, 댓글이면
  이어서 부모 `commentCount`를 `increment(-1)`로 갱신한다(11-2에서 정리한
  대로 순차 호출, 두 번째 호출 실패는 조용히 무시). 성공 시 해당 카드/댓글
  DOM 요소를 제거하고, 댓글 삭제라면 "댓글 N개" 토글 라벨도
  `postComment`가 증가시킬 때와 같은 방식으로 즉시 -1 갱신한다(빠뜨리기
  쉬운 지점이라 명시해 둔다). 버튼은 요청이 끝날 때까지 `disabled`로 잠가서
  더블클릭으로 같은 삭제 요청이 중복 발생하지 않게 한다.
- 시작 화면(5-1)의 "최근 5개" 미리보기는 원래도 읽기 전용이라 여기엔
  수정·삭제 버튼을 추가하지 않는다 — 앱에 들어가서 `Your Thoughts` 탭에서만
  가능하다(기존 설계와 일관).
- 글쓰기/댓글 입력 버튼("게시", "등록")은 `signInAnonymously`가 완료되기
  전까지 비활성 상태로 둔다(대개 수백 ms 내로 끝나지만, 실패 시—예를 들어
  콘솔에서 Anonymous 공급자를 아직 안 켠 경우—"로그인에 실패했어요. 잠시 후
  새로고침해 주세요" 안내를 보여주고 계속 비활성 상태로 둔다).

### 11-5. 구현 단계 (파일별 변경 범위)

1. `index.html`의 Firebase 모듈 스크립트에 `firebase-auth.js` import 추가,
   `getAuth`/`signInAnonymously`/`onAuthStateChanged` 로 `myUid` 확보.
2. `postThought`/`postComment`에 `authorUid: myUid` 필드 추가(기존 `addDoc` +
   `updateDoc(increment(1))` 구조는 그대로 유지, 트랜잭션 도입 안 함).
3. `thoughtCardHtml`/댓글 렌더 함수에 소유자 판별 + 수정·삭제 버튼 마크업,
   `editedAt` 있을 때 "(수정됨)" 라벨 추가.
4. `editThought(id)` / `saveThoughtEdit(id)` / `deleteThought(id)` 및 댓글용
   `editComment(thoughtId, commentId)` / `saveCommentEdit(...)` /
   `deleteComment(thoughtId, commentId)` 함수 추가, 인라인 onclick에서 쓰는
   함수는 전부 `window.fn = fn`으로 노출(기존 1번 구현과 동일한 패턴).
5. `firestore.rules` 파일을 11-3 내용으로 교체.
6. 사용자 액션 안내: Firebase 콘솔에서 Anonymous 로그인 공급자 활성화 +
   갱신된 `firestore.rules`를 콘솔 "규칙" 탭에 다시 붙여넣기.

### 11-6. 테스트 plan

- 브라우저 A에서 글을 하나 쓰고, 같은 브라우저에서 새로고침 후에도 "수정"/
  "삭제" 버튼이 그대로 보이는지 확인(익명 세션이 유지되는지).
- 브라우저 B(다른 세션/시크릿 창)에서 그 글을 보면 수정·삭제 버튼이 아예
  안 보이는지 확인.
- 브라우저 A에서 수정 → 텍스트가 바뀌고 "(수정됨)"이 뜨는지, 브라우저 B에서
  새로고침하면 바뀐 내용이 보이는지 확인.
- 브라우저 A에서 삭제 → 카드가 사라지고, 브라우저 B에서 새로고침해도 그 글이
  더는 안 보이는지 확인.
- 댓글 여러 개를 달았다 지웠다 하면서 "댓글 N개" 카운트가 실제 댓글 수와
  항상 일치하는지 확인(순차 호출 방식이라도 정상 네트워크 환경에서는
  어긋나지 않아야 한다).
- Anonymous 공급자를 아직 안 켠 상태를 가정해 `signInAnonymously` 실패 시
  "게시"/"등록" 버튼이 계속 비활성으로 남고 안내 문구가 뜨는지 확인.
- **보안 규칙 자체 검증(핵심)** — 브라우저 개발자 도구 콘솔에서 UI를
  거치지 않고 직접 `updateDoc`/`deleteDoc`을 호출해서, 브라우저 B(내가
  쓰지 않은 남의 글)의 문서를 고쳐보거나 지워본다. UI에서 버튼을 안
  보여주는 건 눈속임 수준의 방어일 뿐이고, 실제 보안 경계는 Firestore
  규칙이므로 이 테스트가 이번 기능에서 가장 중요하다 — `permission-denied`
  에러로 거부되는 게 확인돼야 통과.
- **회귀 확인** — `firestore.rules` 전체를 11-3 내용으로 교체하므로, 1번
  구현에서 이미 확인했던 기본 흐름(글쓰기 → 시작 화면 최근 5개 반영,
  댓글 달기 → count 증가)이 규칙 교체 후에도 그대로 되는지 다시 확인한다.

### 11-7. Self-review

베스트 plan인지 — 로그인 UI를 전혀 새로 만들지 않고도 소유권을 안전하게
증명할 수 있는 게 Anonymous Auth의 핵심 장점이라, 지금 "닉네임만 입력하면
바로 쓸 수 있는" 캐주얼한 흐름을 그대로 유지하면서 요청받은 기능을 붙이기엔
이 방식이 가장 적절하다.

빠진 게 있는지 — 댓글 삭제 시 부모 글의 서브컬렉션에 남는 문서 정리(orphan
cleanup)나, 글 삭제 cascade는 뺐다(11-2에서 근거 설명). 수정 이력(edit
history) 저장도 안 한다 — "(수정됨)" 표시 하나로 충분하다고 판단했고, 그
이상의 버전 기록은 이번 요청 범위 밖이다.

오버한 게 있는지 — 처음 초안에는 댓글 추가/삭제를 `runTransaction`으로
묶으려 했는데, plan-verify 과정에서 다시 보니 불필요한 복잡도였다.
`increment()`가 이미 서버에서 원자적으로 처리되고, 규칙의 0-미만-금지
검사도 트랜잭션 없이 커밋 시점 값 기준으로 똑같이 동작하기 때문에,
트랜잭션은 실질적 이득 없이 API 사용법만 복잡하게 만드는 과잉 설계였다.
11-2/11-5에서 기존에 이미 검증된 "순차 addDoc/deleteDoc + updateDoc"
패턴으로 되돌렸다. Anonymous Auth 자체는 이번 기능(본인만 수정·삭제)의
필수 전제조건이라 추가한 것이지, 그 이상의 계정 기능(이메일 연동, 프로필
등)은 만들지 않는다.

### 11-8. 사용자 결정 필요 항목

없음 — 범위(글+댓글 모두)는 이미 확인받았고, 나머지는 전부 기술적으로
결정 가능한 항목이라 판단해 바로 설계에 반영했다. 사용자가 해야 하는
액션은 다음 두 가지뿐이다.

- Firebase 콘솔 → Authentication → Sign-in method → **Anonymous** 활성화.
- 갱신된 `firestore.rules` 내용을 Firebase 콘솔의 "규칙" 탭에 다시
  붙여넣고 게시.

## 12. 닉네임 중복 방지 — Firebase 진짜 계정으로 업그레이드

사용자 요청: "닉네임을 한 사람당 하나만 쓰도록, 중복 안 되게." 지금까지는
닉네임이 순수 자유 입력이라 다른 사람이 같은 닉네임을 그대로 입력하면
그 사람 행세를 할 수 있었다(8번 리스크, `spec_site_restructure_i18n.md`
4-2에서 여러 번 짚은 한계). 이번 기능은 그 한계를 실제로 메운다.

**plan-verify 중 설계가 한 번 바뀌었다** — 처음 초안은 지금 구조
(Anonymous Auth)를 그대로 두고 `users/{nickname}` 문서에 비밀번호
해시 필드 하나를 추가해서 Firestore 규칙으로 직접 비교하는 방식이었다.
검증 과정에서 "Firebase 진짜 로그인으로 바꾸면 기존 uid가 깨진다"는
초기 판단이 성급했다는 걸 발견했다 — Firebase Auth의
`linkWithCredential`(익명 계정을 그 자리에서 진짜 계정으로 업그레이드,
uid 그대로 유지)를 공식 문서로 재확인한 결과, uid를 안 깨면서 진짜
로그인 시스템으로 가는 게 가능했다. 아래는 그 결과 확정된 설계다.

### 12-1. 핵심 아이디어 — `linkWithCredential`로 익명 계정을 그대로 업그레이드

닉네임을 이메일처럼 취급한다(`{nickname}@lexbrief.local`, 실제로 메일이
가는 주소는 아니고 Firebase Auth가 이메일 형식을 요구해서 형식만
맞추는 용도). 비밀번호는 사용자가 직접 입력한 값을 그대로 쓴다.

- **새 닉네임(클레임)** — 앱은 이미 익명으로 로그인된 상태다(11번에서
  만든 `signInAnonymously` 흐름 그대로 유지). 여기서
  `linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, password))`
  를 호출하면, 지금 쓰던 익명 계정이 "진짜 계정"으로 승격되면서
  **uid는 그대로 유지된다**(공식 문서: "Users are identifiable by the
  same Firebase user ID regardless of the authentication provider").
  즉 11번에서 만든 `thoughts`/`comments`의 `authorUid` 소유권, 4번의
  Sources & Topics 동기화 로직을 하나도 안 건드려도 된다 — `myUid`가
  바뀌지 않으니까.
- **이미 있는 닉네임(로그인)** — 다른 사람이 이미 그 이메일로 계정을
  만들어놨다면 `linkWithCredential`이 `auth/email-already-in-use`
  (또는 `auth/credential-already-in-use`)로 실패한다. 이 에러를 잡아서
  대신 `signInWithEmailAndPassword(auth, email, password)`를 호출한다
  — 비밀번호가 맞으면 그 계정으로 전환되고(uid가 원래 그 닉네임을
  처음 만들었던 기기의 uid로 바뀐다 — 이게 바로 "다른 기기에서도 내
  계정으로 들어가는" 정상 동작이다), 틀리면 `auth/wrong-password`류
  에러가 나서 그대로 사용자에게 "비밀번호가 틀렸어요"로 안내한다.

이 두 시도(link 실패 → sign-in 시도)만으로 "새 닉네임인지 이미 있는
닉네임인지"를 미리 조회할 필요가 아예 없어진다 — Firebase가 결과로
알려주는 에러 코드를 보고 반응만 하면 된다. 그래서 게이트 UI도 "클레임
모드/로그인 모드"로 미리 갈라놓을 필요 없이 닉네임 + 비밀번호 입력칸
하나씩만 두고, 제출했을 때 결과에 따라 안내 메시지만 바뀌면 된다 —
1차 초안보다 훨씬 단순해졌다.

### 12-2. 왜 이게 1차 초안보다 나은지

- **uid가 그대로 유지된다** — 1차 초안이 걱정했던 "기존 데이터 고아화"
  문제가 애초에 발생하지 않는다.
- **비밀번호 검증을 Firebase가 대신 한다** — 클라이언트에서 직접
  SHA-256 해시를 계산해서 Firestore 규칙으로 비교하는 방식(1차 초안)
  보다 안전하다. Firebase Auth는 서버 측에서 scrypt 계열로 비밀번호를
  저장·검증하고, 그 값이 Firestore 문서에 절대 노출되지 않는다.
- **닉네임 중복 자체를 Firebase Auth가 원천적으로 막아준다** — 같은
  이메일로 두 번째 계정을 못 만드는 건 Firebase Auth의 기본 동작이라,
  Firestore 규칙에서 직접 "이미 있으면 거부" 로직을 짤 필요가 없다.
- **읽기 프라이버시 한계가 사라진다** — 1차 초안은 "Firestore 규칙은
  읽기 요청에 비밀번호를 실어 보낼 수 없어서 읽기 자체는 못 막는다"는
  한계가 있었다. 이번 방식은 `request.auth.uid`가 이제 진짜(기기에
  안 묶인) 소유권 증명이 되므로, `users/{nickname}` 문서의 읽기까지
  `allow read: if request.auth != null && request.auth.uid == resource.data.ownerUid`
  로 막을 수 있다 — 로그인해야만(=비밀번호를 알아야만) 그 프로필을
  읽을 수 있다. `spec_site_restructure_i18n.md` 4-2/9에 적어둔
  "닉네임 위장·엿보기 리스크"가 Sources & Topics/Archive 쪽에서는
  이번 기능으로 실질적으로 해소된다(친구들 공개 게시판인 `thoughts`/
  `comments`는 원래 의도대로 계속 공개로 둔다 — 그건 위장 방지가
  아니라 애초에 "공개 게시판"이라 다른 얘기다).

### 12-3. Firestore 보안 규칙 변경

`users/{nickname}` 블록을 uid 기반 소유권으로 다시 단순화한다(1차
초안의 `pwHash` 필드/create-update 분리 로직은 전부 폐기).

```
match /users/{nickname} {
  allow read: if request.auth != null && request.auth.uid == resource.data.ownerUid;

  allow create: if request.auth != null
                && request.resource.data.ownerUid == request.auth.uid
                && request.resource.data.keys().hasOnly(
                     ['ownerUid','urls','topics','sectors','keywords','companies','lang','trendConfig','updatedAt'])
                && request.resource.data.urls is list && request.resource.data.urls.size() <= 30
                && request.resource.data.keywords is list && request.resource.data.keywords.size() <= 50
                && request.resource.data.companies is list && request.resource.data.companies.size() <= 30
                && request.resource.data.lang is string;

  allow update: if request.auth != null
                && request.auth.uid == resource.data.ownerUid
                && request.resource.data.ownerUid == resource.data.ownerUid
                && request.resource.data.keys().hasOnly(
                     ['ownerUid','urls','topics','sectors','keywords','companies','lang','trendConfig','updatedAt'])
                && request.resource.data.urls is list && request.resource.data.urls.size() <= 30
                && request.resource.data.keywords is list && request.resource.data.keywords.size() <= 50
                && request.resource.data.companies is list && request.resource.data.companies.size() <= 30
                && request.resource.data.lang is string;

  match /archive/{entryId} {
    allow read: if request.auth != null && request.auth.uid == get(/databases/$(database)/documents/users/$(nickname)).data.ownerUid;
    allow create: if request.auth != null
                  && request.auth.uid == get(/databases/$(database)/documents/users/$(nickname)).data.ownerUid
                  && request.resource.data.html is string && request.resource.data.html.size() <= 200000
                  && request.resource.data.context is string && request.resource.data.context.size() <= 50000;
    allow update: if false;
    allow delete: if false;
  }
}
```

서브컬렉션 `archive`의 읽기·쓰기 규칙에서 `get(...)`으로 부모
`users/{nickname}` 문서를 조회해 `ownerUid`를 대조하는 이유는,
서브컬렉션 규칙은 자기 문서(`resource.data`)만 보고는 소유자를 알
방법이 없어서다 — 부모 문서를 한 번 더 읽어와야 한다. Firestore
규칙에서 `get()`은 별도 읽기 횟수로 과금되지만(콘솔 사용량에 반영),
이 프로젝트 규모에서는 무시할 만한 수준이라고 판단했다.

`thoughts`/`comments` 컬렉션 규칙(11번)은 이번 변경과 무관하다 —
`authorUid`가 uid 기준이고, 이번에도 uid가 안 바뀌므로 손댈 필요가
없다.

### 12-4. 게이트 UI/흐름 변경

닉네임 입력창 밑에 비밀번호 입력칸 하나만 추가한다(확인용 재입력
칸은 넣지 않기로 했다 — 첫 클레임에서 오타가 나면 그 비밀번호를
잊은 것과 똑같이 취급되는데, 이건 이미 "비밀번호를 잊으면 새
닉네임을 골라야 한다"는 트레이드오프로 받아들이기로 한 것과 같은
카테고리의 실패라 재입력 칸으로 막을 만큼 크게 다른 문제가 아니라고
판단했다 — 1차 초안보다 화면을 더 단순하게 유지하는 쪽을 택했다).

`enterApp()`이 비동기로 바뀐다.

```js
async function enterApp() {
  const v  = document.getElementById('gate-nickname').value.trim().replace(/\//g, '');
  const pw = document.getElementById('gate-password').value;
  if (!v || pw.length < 4) return;
  if (!auth.currentUser) { showGateError('로그인 준비 중이에요. 잠시 후 다시 시도해주세요.'); return; }
  const email = v + '@lexbrief.local';
  let claimed = false;

  try {
    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, pw));
    claimed = true; // 새 닉네임 클레임 성공 — uid는 그대로, 프로필 문서가 아직 없다
  } catch (e) {
    // already-in-use: 다른 uid가 이미 이 닉네임을 가짐. provider-already-linked:
    // 이 브라우저가 새로고침 전에 이미 그 닉네임으로 로그인돼 있던 경우(12-4 하단 참고).
    // 두 경우 모두 "로그인 시도로 전환"이 맞는 처리다.
    if (['auth/email-already-in-use', 'auth/credential-already-in-use', 'auth/provider-already-linked'].includes(e.code)) {
      try {
        await signInWithEmailAndPassword(auth, email, pw);
        // 기존 닉네임 로그인 성공 — uid가 그 계정의 uid로 전환된다
      } catch (e2) {
        showGateError('비밀번호가 틀렸어요.');
        return;
      }
    } else {
      showGateError('로그인에 실패했어요: ' + e.message);
      return;
    }
  }

  nickname = v;
  try { localStorage.setItem(NICK_KEY, nickname); } catch {}
  document.getElementById('start-gate').classList.add('hidden');
  document.getElementById('app-root').style.display = 'flex';
  if (!feedLoaded) initThoughtsFeed();
  if (claimed) {
    syncUserProfile(); // 프로필 문서를 지금 만들어 둔다 — Settings를 한 번도
                        // 안 건드리고 나가도 archive 저장(12-3의 get() 검증)이
                        // 항상 성립하도록. 클레임 케이스에서만 호출한다.
  } else {
    loadUserProfile(nickname); // 로그인 케이스만 — 저장된 진짜 값을 끌어와서
                                // 지금 브라우저의 로컬 기본값을 덮어쓴다
  }
  loadArchiveFromCloud(nickname);
}
```

로그인(기존 닉네임) 케이스에서 `syncUserProfile()`을 호출하지 않고
`loadUserProfile()`만 호출하는 순서가 중요하다 — 반대로 하면 이
브라우저의 로컬 기본값(아직 진짜 설정을 못 받아온 상태)이 클라우드에
저장된 진짜 값을 덮어써 버리는 사고가 난다. plan-verify 중에 이
순서 실수를 잡아서 바로잡았다.

`onAuthStateChanged`(11번에서 이미 만든 리스너)가 `linkWithCredential`/
`signInWithEmailAndPassword` 양쪽 모두에서 자동으로 다시 발화해서
`myUid`를 최신 값으로 갱신해 준다 — 이 부분은 이미 있는 코드라 손댈
필요가 없다.

**모듈 스크립트 최상단의 `signInAnonymously(auth)` 호출도 조건부로
바꿔야 한다** — 지금은 페이지가 열릴 때마다 무조건 호출하는데, 이미
영구 계정(예: "Alice")으로 로그인했던 브라우저가 새로고침됐을 때
이 무조건 호출이 그 영구 세션을 밀어내고 새 익명 세션으로 덮어써
버릴 위험이 있다(Firebase Auth는 브라우저 재방문 시 이전 세션을
IndexedDB에서 복원하는데, 그 복원이 끝나기 전에 `signInAnonymously`
가 먼저 실행되면 복원된 세션과 충돌한다). `onAuthStateChanged`의
첫 콜백에서 `auth.currentUser`가 이미 있는지 확인한 뒤에만
`signInAnonymously`를 호출하도록 고친다.

```js
let authInitDone = false;
onAuthStateChanged(auth, user => {
  if (!authInitDone) {
    authInitDone = true;
    if (!user) signInAnonymously(auth).catch(() => setComposeEnabled(false, '로그인에 실패했어요. 잠시 후 새로고침해 주세요.'));
  }
  if (!user) return;
  myUid = user.uid;
  setComposeEnabled(true);
  if (feedLoaded) initThoughtsFeed();
});
```

`syncUserProfile()`(4-4)은 매 저장마다 `ownerUid: myUid`를 같이
실어 보내도록 한 줄 추가한다(생성 시점엔 자기 uid를 써서 소유권을
못박고, 이후 매 update마다 규칙이 `request.auth.uid ==
resource.data.ownerUid`로 대조하므로 이 필드가 항상 필요하다).
비밀번호는 이전과 마찬가지로 로컬스토리지에 저장하지 않는다 — 매번
다시 입력해야 하지만 Firebase Auth 세션 자체는 브라우저에 안전하게
유지되므로(IndexedDB), 같은 브라우저로 재방문 시에는 재로그인 절차
없이 이미 로그인된 상태로 남아있을 가능성이 높다(11번에서 익명 세션이
새로고침 후에도 유지됐던 것과 같은 이유). 다만 게이트 자체는 지금
설계대로 "매번 뜨고 시작하기를 눌러야" 하는 흐름을 유지하므로, 실제로는
매번 비밀번호를 다시 물어보게 된다 — 이 부분은 요청하신 "닉네임을
넣어야 시작하기가 눌리게" 원래 취지와 일치하는 선택이라고 보고
그대로 뒀다.

### 12-5. 사용자 액션 — Firebase 콘솔 설정 + 기존 데이터 정리

- Firebase 콘솔 → Authentication → Sign-in method → **Email/Password**
  공급자 활성화(지금까지는 Anonymous만 켜져 있었다. 새로 하나 더
  켜야 한다).
- 갱신된 `firestore.rules` 재게시.
- 기존 닉네임 정리 — 사용자가 "기존 닉네임을 모두 삭제"로 확정했다.
  지금 Firestore의 `users/*`, `thoughts/*`(와 각 서브컬렉션)는 이번
  세션에서 기능 검증하며 만든 테스트 데이터뿐이다(`ZZZ_TestOnly_Phase2`,
  `Phase2Tester`, `OwnerFlow` 등). 이 정리는 제가 클라이언트 코드로
  대신 할 수 없다 — 지금까지의 모든 규칙 버전에 `users`/`archive`
  삭제를 허용하는 조항이 없었고, `thoughts`도 작성자 본인 uid만
  삭제 가능한데 그 익명 세션들은 이미 브라우저를 닫아 사라진 상태라
  저도 지울 방법이 없다(관리자 자격 증명도 없다). Firestore
  콘솔에서 `thoughts`/`users` 컬렉션 오른쪽 "⋮" 메뉴 → "컬렉션 삭제"
  로 몇 번의 클릭이면 끝난다.

### 12-6. 구현 단계

1. 모듈 스크립트 import에 `EmailAuthProvider`, `linkWithCredential`,
   `signInWithEmailAndPassword` 추가.
2. 게이트 마크업에 비밀번호 입력칸 하나 추가, 에러 메시지 표시 영역
   추가.
3. `enterApp()`을 12-4의 비동기 link→fallback sign-in 흐름으로
   재작성.
4. `syncUserProfile()`에 `ownerUid: myUid` 필드 추가.
5. `firestore.rules`에 12-3 규칙 반영.
6. 사용자 액션(12-5): Email/Password 공급자 활성화, 규칙 재게시,
   기존 컬렉션 삭제.

### 12-7. 테스트 plan

- 존재하지 않는 새 닉네임 + 비밀번호로 시작 → 성공적으로 앱에 들어가고,
  Firestore에 `users/{nickname}` 문서가 `ownerUid`와 함께 생성되는지.
- 같은 브라우저에서 새로고침 후 같은 닉네임+같은 비밀번호로 재입력 →
  정상적으로 들어가지는지(uid가 안 바뀌었는지 콘솔에서 확인).
- 완전히 다른 브라우저 세션에서 같은 닉네임 + **틀린** 비밀번호 →
  "비밀번호가 틀렸어요"로 막히고 앱에 못 들어가는지.
- 완전히 다른 브라우저 세션에서 같은 닉네임 + **맞는** 비밀번호 →
  들어가지고, Sources & Topics 설정이 정상적으로 동기화되는지(4번
  기능이 이번 변경 이후에도 여전히 되는지 회귀 확인).
- 개발자 도구에서 로그인 안 한(또는 다른 계정으로 로그인한) 상태로
  남의 `users/{nickname}` 문서를 직접 `getDoc`으로 읽어보기 시도 →
  `permission-denied`로 거부되는지(12-2에서 얘기한 "읽기 프라이버시
  개선"이 실제로 규칙에 반영됐는지 확인하는 핵심 테스트).
- **Settings를 전혀 안 건드리고 바로 브리핑만 생성** — 새 닉네임을
  클레임한 직후, Sources & Topics는 한 번도 안 열고 곧장 Daily
  Briefing에서 브리핑을 하나 만들었을 때 `users/{nickname}` 문서가
  이미 만들어져 있어서(클레임 시점의 명시적 `syncUserProfile()` 호출
  덕분에) archive 저장이 실제로 성공하는지 확인.
- **같은 브라우저에서 새로고침 후 재확인** — 한 번 클레임에 성공한
  브라우저를 새로고침했을 때, `signInAnonymously` 가드 덕분에 영구
  계정 세션이 안 밀려나는지(개발자 도구에서 uid가 새로고침 전후로
  같은지 직접 대조), 게이트에 같은 닉네임+비밀번호를 다시 입력해도
  `auth/provider-already-linked` 같은 에러 없이 매끄럽게 들어가지는지.

### 12-8. Self-review

베스트인지 — plan-verify 과정에서 처음 접근(커스텀 해시 + Firestore
규칙 직접 비교)보다 Firebase Auth의 계정 연결 기능을 쓰는 쪽이 uid
안정성, 보안, 구현 단순성 세 가지를 동시에 만족시킨다는 걸 확인하고
전면 교체했다. 지금 시점에서는 이게 최선이라고 판단한다.

빠진 게 있는지 — 이 재설계 자체를 검증하다가 두 가지를 더 잡았다.
하나는 클레임 직후 Settings를 한 번도 안 건드리면 `users/{nickname}`
문서가 아예 안 생겨서 archive 저장(12-3의 `get()` 검증)이 조용히
실패하는 문제였고(클레임 케이스에서 `syncUserProfile()`을 명시적으로
호출하도록 고쳤다), 다른 하나는 로그인 케이스에서 순서를 잘못
잡으면 이 브라우저의 로컬 기본값이 클라우드의 진짜 저장값을 덮어써
버리는 문제였다(로그인 케이스는 `syncUserProfile()`이 아니라
`loadUserProfile()`만 호출하도록 분리했다). 세 번째로, 페이지
새로고침 시 무조건 `signInAnonymously`를 부르던 기존 코드가 영구
계정 세션을 밀어낼 수 있어서 조건부 호출로 바꿨다. 비밀번호
재설정(찾기) 기능은 여전히 없다(12-4에서 근거 설명, 1차 초안과 같은
트레이드오프 유지) — Firebase의 진짜 비밀번호 재설정 이메일 기능
(`sendPasswordResetEmail`)을 쓰려면 실제 이메일 주소를 받아야
하는데, 그러면 "닉네임만으로 시작"하는 지금 앱의 핵심 UX가 깨지므로
범위에 넣지 않았다.

오버한 게 있는지 — 확인용 비밀번호 재입력 칸을 1차 초안에서는
넣었다가 이번에 뺐다 — 화면을 단순하게 유지하는 쪽이 이 앱의 기존
톤(닉네임 하나로 바로 시작)과 더 맞는다고 재판단했다. `archive`
서브컬렉션 규칙에 `get()` 호출을 추가한 것도 최소한의 필요(소유자
대조)를 위한 것이지 그 이상은 아니다.

### 12-9. 사용자 결정 필요 항목

없음 — 마이그레이션 정책과 기존 데이터 처리는 이미 답변받았고, 이번
재설계(Firebase Auth 계정 연결 방식)는 사용자가 원래 요청한 "중복
안 되게"를 더 잘 만족시키는 기술적 선택이라 별도로 여쭤볼 지점은
없다고 판단했다. 사용자가 해야 하는 액션은 12-5에 정리된 세 가지
(Email/Password 공급자 활성화, 규칙 재게시, 기존 컬렉션 삭제)다.

