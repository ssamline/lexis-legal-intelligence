# Plan — 브라우저가 이미 다른 닉네임에 묶여 있을 때 새 닉네임 등록 실패 버그 수정

상태: 원인 확정(find-cause), 인터뷰 1건 반영, 구현 대기.

## 0. 인터뷰 결정 사항

브라우저가 이미 다른 닉네임 계정에 연결돼 있는 상태에서 사용자가 새(또는
다른) 닉네임을 입력하면, 별도 확인 창 없이 바로 기존 로그인 상태를 지우고
새로 입력한 닉네임으로 등록/로그인을 시도하기로 확정했다("바로 조용히
전환" 안, 추천안이자 사용자가 선택한 안).

## 1. 원인 (find-cause로 확정, 재현 완료)

운영 사이트(`lexis-legal-intelligence.onrender.com`)에서 Playwright로
직접 재현했다 — 같은 브라우저 세션에서 닉네임 A로 정상 등록 → 페이지
새로고침(브라우저를 껐다 켜는 것과 동일) → 한 번도 안 쓰인 완전히 새로운
닉네임 B로 등록 시도 → "Wrong password."가 뜨며 실패. B는 실존하지 않는
계정이라 비밀번호가 틀릴 수가 없는데도 이 메시지가 뜬다.

원인은 `enterApp()`(`index.html:2629`)의 로직 순서에 있다.

- Firebase Auth 세션은 브라우저에 영구 저장되고 새로고침해도 유지된다
  (`onAuthStateChanged` 핸들러의 주석, `index.html:2523-2525`, 이 동작은
  의도된 것 — 매번 새로 로그인 안 해도 되게 하려는 설계다).
- 한 번이라도 닉네임을 성공적으로 등록한 브라우저는 `auth.currentUser`가
  "빈 익명 계정"이 아니라 "이미 이메일/비밀번호 provider가 연결된 영구
  계정"이 된다.
- `enterApp()`은 매번 무조건 `linkWithCredential(auth.currentUser, ...)`
  부터 시도한다(`index.html:2642`). Firebase 계정 하나엔 이메일/비밀번호
  provider를 하나만 연결할 수 있어서, 이미 다른 닉네임에 연결된
  `auth.currentUser`로는 무슨 닉네임을 입력하든 이 호출이
  `auth/provider-already-linked`로 실패한다.
- 코드는 이 에러 코드를 "이미 이 닉네임으로 로그인했던 적 있다"로만
  해석해서(`index.html:2648`) `signInWithEmailAndPassword`로 넘어간다
  (`index.html:2650`). 하지만 대상은 방금 입력한 **새** 닉네임의
  이메일이라 애초에 그 계정이 없거나, 있어도 다른 사람 계정이라 비밀번호가
  맞을 리 없다 — 그래서 무조건 실패하고 `gate.wrong_password`가 뜬다
  (`index.html:2652`).

즉 이 앱은 한 번이라도 닉네임을 등록한 브라우저에서는 **그 닉네임으로만**
다시 들어갈 수 있고, 비밀번호를 잊으면 같은 브라우저에서 새 닉네임 등록도
막혀버리는 구조적 결함이다. 확신도 95% — 재현 테스트로 정확한 경로를
확인했고, 남은 불확실성은 실제 사용자 브라우저의 Firebase 세션 지속성
설정이 테스트 환경과 동일하다는 전제뿐인데 이건 SDK 기본값이라 사실상
확실하다.

## 2. 관련 코드 파악

- `index.html:1680-1683` — `firebase-auth.js`에서 import하는 함수 목록.
  현재 `getAuth, signInAnonymously, onAuthStateChanged, EmailAuthProvider,
  linkWithCredential, signInWithEmailAndPassword`만 있고 `signOut`은 없다.
- `index.html:2519-2536` — `onAuthStateChanged` 핸들러. `authInitDone`
  플래그로 최초 1회만 "세션이 아예 없으면 익명 로그인" 자동 실행을 하고,
  이후로는 `user` 값이 뭐든 `myUid`만 갱신한다. 즉 이번 수정에서
  `signOut(auth)` → `signInAnonymously(auth)`를 명시적으로 호출해도, 이
  핸들러가 중복으로 또 로그인을 시도하지 않는다(`authInitDone`이 이미
  true라서) — 기존 로직과 충돌 없이 그대로 맞물린다.
- `index.html:2958-2963` — 페이지 로드 시 게이트 닉네임 입력창에
  `localStorage`의 `NICK_KEY` 값을 미리 채워 넣긴 하지만, 비밀번호는 항상
  빈 값이고 게이트 자체를 건너뛰는 로직은 없다 — 즉 세션이 이미 있어도
  사용자는 매번 `enterApp()`을 거쳐야 한다. 이번 수정이 `enterApp()`
  안에서만 이뤄지면 모든 진입 경로를 커버한다.
- `EmailAuthProvider.PROVIDER_ID`는 Firebase Auth SDK에서 `'password'`
  고정 문자열이다 — `auth.currentUser.providerData`에서 이 providerId를
  가진 항목을 찾으면 현재 이 브라우저가 연결된 이메일(=닉네임)을 알 수
  있다.

## 3. 구현 — `enterApp()` 앞부분에 세션 리셋 로직 추가

### 3-1. import에 `signOut` 추가

`index.html:1680-1683`을 아래로 교체.

```js
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut,
  EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
```

### 3-2. `enterApp()` 앞부분에 불일치 감지 + 리셋 삽입

`index.html:2629-2644`를 아래로 교체(기존 `linkWithCredential` 이후
catch 블록은 그대로 둔다).

```js
async function enterApp() {
  const v  = document.getElementById('gate-nickname').value.trim().replace(/\//g, ''); // '/' would break the Firestore doc path
  const pw = document.getElementById('gate-password').value;
  showGateError('');
  if (!v || pw.length < 4) return;
  if (!auth.currentUser) { showGateError(t('gate.signing_in')); return; }

  const btn = document.getElementById('gate-enter-btn');
  btn.disabled = true;
  const email = v + '@lexbrief.local';

  // Firebase Auth session persists across reloads. If this browser is already
  // permanently linked to a DIFFERENT nickname's account, linkWithCredential()
  // below always fails with 'provider-already-linked' no matter what's typed,
  // and the old fallback (signInWithEmailAndPassword against the newly typed
  // nickname) always failed too — surfacing a misleading "Wrong password" for
  // an account that was never actually attempted. Reset to a fresh anonymous
  // session first so the typed nickname gets a clean shot.
  const linkedEmail = auth.currentUser.providerData.find(p => p.providerId === 'password')?.email;
  if (linkedEmail && linkedEmail !== email) {
    try {
      await signOut(auth);
      await signInAnonymously(auth);
    } catch (e) {
      showGateError(t('gate.signin_failed', {msg: e.message}));
      btn.disabled = false;
      return;
    }
  }

  let claimed = false;
  try {
    await linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, pw));
    claimed = true; // new nickname claimed — uid unchanged, profile doc doesn't exist yet
  } catch (e) {
```

이 뒤로는 기존 `catch` 블록(`index.html:2644-2661`)과 나머지
(`index.html:2663` 이후)를 그대로 둔다 — 이 부분의 로직 자체는 이미
맞았고(같은 닉네임으로 재로그인하는 정상 케이스, 다른 사람이 이미 쓰는
닉네임에 잘못된 비밀번호를 넣는 케이스 등), 문제는 그 앞에서 "애초에
낯선 닉네임인데 예전 계정에 발이 묶여 있는" 상황을 구분 못 했던 것뿐이다.

`linkedEmail === email`인 경우(=지금 로그인된 닉네임과 정확히 같은
닉네임·같은 비밀번호로 다시 들어오려는 정상적인 재접속)는 리셋을 건너뛰고
기존 흐름 그대로 진행된다 — 이 케이스는 이미 정상 동작하던 부분이라
건드리지 않는다.

인터뷰에서 확정한 대로 confirm 창이나 안내 메시지 없이 조용히 전환한다.
전환 사실을 알리는 토스트/안내 문구도 의도적으로 추가하지 않았다 — 그런
걸 넣으면 사실상 "확인 후 전환"에 가까워져서 인터뷰 결정과 어긋난다.

## 4. 테스트 plan

- (회귀 확인) 브랜드 뉴 브라우저 세션에서 새 닉네임 등록 → 정상 진입되는지
  (기존에도 되던 케이스, 안 깨졌는지 확인).
- (회귀 확인) 같은 닉네임으로 다른 세션에서 올바른 비밀번호로 재로그인 →
  정상 진입되는지.
- (회귀 확인) 같은 닉네임으로 틀린 비밀번호 입력 → "Wrong password." 정상
  표시되는지(이번 수정으로 `linkedEmail === email`이라 리셋이 안 걸리는
  경로).
- **(버그 수정 확인, 핵심)** 닉네임 A로 등록 → 새로고침 → 한 번도 안 쓴
  닉네임 B로 등록 시도 → 이번엔 "Wrong password." 없이 정상 등록되고
  앱에 진입되는지. 이게 이번에 재현했던 버그 시나리오 그대로다.
- (엣지케이스) 닉네임 A로 등록 → 새로고침 → **다른 브라우저 세션에서
  이미 등록된 닉네임 C**를 맞는 비밀번호로 입력 → 리셋 후 C 계정으로
  정상 로그인되는지("새 기기에서 기존 닉네임으로 복귀"가 여전히 되는지).
- (엣지케이스) 닉네임 A로 등록 → 새로고침 → 다른 브라우저 세션에서 이미
  등록된 닉네임 C를 틀린 비밀번호로 입력 → 리셋은 되지만 그 뒤
  `signInWithEmailAndPassword`가 실패해서 "Wrong password."가 정상적으로
  뜨는지(이번엔 진짜로 비밀번호가 틀린 경우라 이 메시지가 맞다).
- 리셋이 걸리는 케이스에서 `myUid`가 새 계정의 uid로 정확히 갱신되고,
  `claimed`가 true인 신규 등록 시 `syncUserProfile()`이 새 uid로 프로필
  문서를 정상 생성하는지 Firestore에서 확인.

## 5. 리스크 / 엣지케이스

인터뷰에서 확정한 대로, 사용자가 원래 자기 닉네임을 오타 낸 채로
입력하면 확인 없이 바로 그 세션에서 로그아웃되고 오타 닉네임으로 새
계정이 생긴다 — 이건 "바로 조용히 전환" 방식을 선택하면서 감수하기로
한 트레이드오프다. 실사용 중 이게 자주 문제가 되면, 그때 가서 확인 창
방식으로 바꾸는 건 이번 코드 구조에서 쉽게 추가할 수 있다(리셋 직전에
`confirm(...)` 한 줄만 끼워 넣으면 된다).

`signOut(auth)` → `signInAnonymously(auth)` 사이, 그리고 그 뒤
`linkWithCredential` 완료까지는 몇 번의 네트워크 왕복이 필요해서 순간적으로
버튼이 비활성화된 상태로 몇백 ms~1초 정도 대기 시간이 생길 수 있다 —
게이트 화면이 전체 화면을 덮고 있어서(`z-index:2000`) 사용자에게 어색한
깜빡임 없이 그냥 "등록 중" 정도로 보일 것으로 판단해 별도 로딩 표시는
추가하지 않았다.

## 6. Self-review

**베스트 plan인지** — `enterApp()` 안에서 리셋 여부를 판단하는 조건 하나만
추가하는 최소 변경이다. 기존 `linkWithCredential`/`signInWithEmailAndPassword`
분기 로직은 이미 정상 케이스들을 다 처리하고 있었어서 손대지 않았고,
새 서버 로직이나 새 Firestore 필드도 필요 없다.

**빠진 게 있는지** — `onAuthStateChanged`가 `signOut`/`signInAnonymously`
호출과 충돌 없이 맞물리는지, 게이트가 세션 유무와 무관하게 항상
`enterApp()`을 거치는지(즉 이 함수 하나만 고치면 모든 진입 경로가
커버되는지) 둘 다 코드로 확인했다.

**오버한 게 있는지** — 인터뷰에서 확정한 대로 확인 창이나 전환 안내
토스트를 추가하지 않았다. 브라우저 전체에서 로그아웃하는 별도 버튼(예:
헤더에 "다른 닉네임으로 로그인" 메뉴)도 만들지 않았다 — 이번 요청은
"닉네임 등록이 실패하는 버그"였지, 로그아웃 UI 자체를 새로 만들어
달라는 요청이 아니었으므로 범위를 넘어선다고 판단했다.

**테스트 충분한지** — 4번에 기존 정상 케이스 3개(회귀), 버그 재현
시나리오 그대로의 수정 확인 1개, 그리고 "다른 사람 닉네임에 올바른/틀린
비밀번호" 엣지케이스 2개까지 포함했다. Firestore 프로필 문서가 새
uid로 정확히 생성되는지도 넣었다.

## 7. 사용자 결정 필요 항목

없음 — 유일한 트레이드오프였던 전환 방식(조용히 전환 vs 확인 후 전환)은
0번에서 이미 인터뷰로 확정됐다.
