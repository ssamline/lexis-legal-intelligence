# Plan — 닉네임별 설정 격리 버그 수정 + Sharing Thoughts 실시간 동기화

상태: 원인 확정(find-cause), 인터뷰 불필요(자문 결과 전부 아키텍처 판단
영역), 구현 대기.

## 0. 인터뷰 자문 결과

질문 list를 만들기 전에 각 결정 항목을 자문했다. "신규 닉네임의 초기
언어를 브라우저 마지막 언어로 둘지 사이트 기본값(en)으로 리셋할지",
"실시간 렌더링을 필드 단위 패치로 할지 카드 전체 재생성으로 할지",
"live 피드 개수 제한을 얼마로 둘지" 세 가지 모두 사용자의 UX 취향이라기
보다는 코드 구조·성능 트레이드오프를 아는 사람이 결정하면 되는 항목이라
판단해서 인터뷰 없이 아래 각 섹션에서 근거와 함께 직접 결정했다.

## 1. 요청 요약 (find-cause로 원인 확정한 두 가지 + 신규 기능 하나)

- **(버그) 설정 격리** — 같은 브라우저에서 여러 닉네임을 테스트하면, 새
  닉네임이 이전 닉네임의 Sources & Topics(URL·Legal Topics·Business
  Sectors·키워드·회사) 설정을 그대로 물려받은 채로 Firestore 프로필이
  생성된다. 사용자가 "모두에게 공유되는 것 같다"고 느낀 실제 원인이다.
- **(이미 동작 확인, 손 안 댐) 언어 유지** — 기존 닉네임으로 재로그인하면
  Firestore에 저장된 언어가 이미 정확히 복원된다(`loadUserProfile`).
- **(신규 기능) Sharing Thoughts 실시간 동기화** — 지금은 한 번 불러온
  뒤로는 새로고침 전까지 남이 쓴 글·댓글·수정·삭제가 안 보인다. 글쓴이
  닉네임 표시는 이미 되고 있다. "자동으로 모두에게 반영"만 새로 만들면
  된다.

## 2. 원인 (find-cause에서 확정, 재확인)

- `index.html:648-686` — 페이지가 열리자마자, 닉네임을 알기도 전에
  `lexbrief_urls`/`lexbrief_topics`/`lexbrief_sectors`/`lexbrief_keywords`/
  `lexbrief_companies`가 **브라우저 전체 공용** `localStorage` 키에서
  무조건 복원된다.
- `index.html:2570-2581` `syncUserProfile()` — 새 닉네임을 처음 등록할 때
  (`enterApp()`의 `claimed=true` 분기, `index.html:2687`)
  `window.S.*`의 **그 순간 값**을 그대로 그 닉네임의 Firestore 프로필로
  저장한다. 이 시점의 `S.*`는 방금 위에서 언급한 공용 캐시에서 온 값이라,
  이전에 이 브라우저에서 로그인했던 다른 닉네임의 설정이 새 닉네임의
  "최초 설정"으로 그대로 굳어버린다.
- 반대로 `S.archive`(`loadArchiveFromCloud`, `index.html:2584-2591`)는
  로그인할 때마다 그 닉네임의 Firestore 서브컬렉션을 무조건 다시 읽어
  덮어쓰기 때문에 이미 올바르게 격리돼 있다 — 문제는 로컬 캐시를 거치는
  Sources & Topics 계열 필드에만 있다.
- `ALARM.times`(Archive Schedule, `index.html:693`, `lb_alarm` 키)도
  같은 패턴이라 동일하게 오염된다 — Sources & Topics 패널 안에 있는
  설정이라 이번 수정 범위에 같이 넣는다.
- Sharing Thoughts는 `initThoughtsFeed()`(`index.html:2881`)가
  `getDocs()`로 1회성 조회만 하고, 코드 전체에 `onSnapshot` 호출이 전혀
  없다(grep으로 확인) — 실시간 반영 자체가 없는 게 맞다.

## 3. 구현 A — 닉네임 전환 시 로컬 설정 캐시 리셋

지난 로그인 버그 수정에서 이미 `enterApp()`(`index.html:2629`)에
"브라우저가 이미 다른 닉네임에 연결돼 있으면 Firebase Auth 세션을
리셋"하는 블록을 추가했다(`linkedEmail && linkedEmail !== email`). 이번엔
**같은 조건의 같은 블록 안에** 로컬 설정 캐시도 같이 리셋한다 — Auth
세션만 리셋하고 로컬 설정은 안 지우면 여전히 오염이 발생하기 때문이다.

### 3-1. 리셋 헬퍼 함수 추가

`S` 객체 정의(`index.html:606-617`) 바로 아래에 하드 기본값을 아는 리셋
함수를 추가한다.

```js
function resetLocalSettingsToDefaults() {
  S.urls      = ['law360.com', 'courthousenews.com'];
  S.topics    = { ip: true, reg: true, lit: true, corp: true };
  S.sectors   = {};
  S.keywords  = [];
  S.companies = [];
  ALARM.times = ['08:00'];
  try {
    localStorage.removeItem('lexbrief_urls');
    localStorage.removeItem('lexbrief_topics');
    localStorage.removeItem('lexbrief_sectors');
    localStorage.removeItem('lexbrief_keywords');
    localStorage.removeItem('lexbrief_companies');
    localStorage.removeItem('lb_alarm');
  } catch {}
  // Re-render every affected UI piece so a switched-in nickname sees a
  // truly blank slate immediately, before loadUserProfile() (existing
  // nickname) or the user's own first edit (new nickname) repopulates it.
  document.getElementById('url-items').innerHTML = S.urls.map(v =>
    `<div class="url-item"><span>${escHtml(v)}</span><button class="url-del" onclick="removeUrl(this,'${escHtml(v)}')">×</button></div>`
  ).join('');
  document.querySelectorAll('.topic-pill[data-topic]').forEach(el => el.classList.remove('off'));
  document.querySelectorAll('.topic-pill[data-sector]').forEach(el => el.classList.add('off'));
  renderKwChips();
  renderCoChips();
  renderAlarmTimes();
}
```

언어(`currentLang`/`lexbrief_lang`)는 의도적으로 건드리지 않는다 — 아래
6번에서 이유를 설명한다.

### 3-2. `enterApp()`의 리셋 블록에서 호출

`index.html:2647-2657`(지난 로그인 버그 수정에서 추가한 블록)을 아래로
교체 — `signOut`/`signInAnonymously` 다음 줄에 한 줄만 추가한다.

```js
  const linkedEmail = auth.currentUser.providerData.find(p => p.providerId === 'password')?.email;
  if (linkedEmail && linkedEmail !== email) {
    try {
      await signOut(auth);
      await signInAnonymously(auth);
      resetLocalSettingsToDefaults();
    } catch (e) {
      showGateError(t('gate.signin_failed', {msg: e.message}));
      btn.disabled = false;
      return;
    }
  }
```

이후 흐름은 그대로다 — `claimed=true`(신규 닉네임)면 방금 리셋된 깨끗한
기본값이 `syncUserProfile()`로 저장되고, `claimed=false`(기존 닉네임
재로그인)면 `loadUserProfile()`이 그 닉네임의 실제 Firestore 값으로 다시
덮어쓴다(리셋 → 로드 순서라 최종 결과는 항상 그 닉네임의 진짜 값이다).

### 3-3. 브라우저가 애초에 아무 닉네임에도 안 묶여 있던 경우는 손 안 댐

`linkedEmail`이 없는 경우(이 브라우저에서 처음으로 아무 닉네임도 등록한
적 없는 경우)는 리셋 블록 자체가 안 걸린다 — 이 경우 `S.*`는 애초에
모듈 로드 시점의 하드 기본값 그대로이므로 오염될 소지가 없다(2번에서
확인). 별도 처리가 필요 없다.

## 4. 구현 B — Sharing Thoughts 실시간 동기화

### 4-1. import 추가

`index.html:1676-1679`에 `onSnapshot`을 추가한다.

```js
import {
  getFirestore, collection, addDoc, getDocs, getDoc, setDoc, doc, updateDoc, deleteDoc, increment,
  query, orderBy, limit, startAfter, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
```

### 4-2. 설계 방향 — 단일 진실 공급원

지금은 "글쓴이 본인은 `postThought()`/`saveThoughtEdit()`/`deleteThought()`
안에서 수동으로 DOM을 패치하고, 다른 사람은 아무것도 못 본다"는 구조다.
이걸 "`onSnapshot` 리스너 하나가 추가/수정/삭제를 전부 렌더링하고, 글쓴이
본인을 포함한 모두가 그 리스너를 통해서만 화면을 갱신받는다"는 구조로
바꾼다. 이렇게 하면 본인용 낙관적 렌더링 코드와 실시간 렌더링 코드가
따로 존재하지 않아도 된다 — Firestore SDK가 로컬 쓰기를 서버 확인 전에도
즉시 스냅샷에 반영해주기 때문에(오프라인 우선 캐시), 글쓴이 본인
체감 속도도 지금과 차이가 없다.

카드 전체를 매번 다시 그리지 않고 **필드 단위로 패치**하는 이유는, 다른
사람이 어떤 글을 수정·삭제했을 때 내가 지금 보고 있는(댓글 패널을 열어
둔) 다른 카드까지 통째로 다시 그려지면서 열어둔 댓글 패널이 접혀버리는
걸 막기 위해서다. 바뀐 카드 자체가 아니라 "화면에 떠 있는 다른 카드들"의
상태를 지켜주는 게 목적이다.

댓글 목록(패널을 펼쳤을 때)은 반대로 **패널 통째로 다시 그리는 방식**을
쓴다 — 댓글 목록은 짧고 한 스레드 안에서 "내가 편집 중인 동안 남이 같은
스레드에 댓글을 단다"는 경합은 실사용 빈도가 낮다고 판단해서, 필드
단위 패치까지 만드는 건 이 규모의 앱에 과하다고 봤다(범위 최소화).

### 4-3. `initThoughtsFeed()` — `getDocs` → `onSnapshot`

`index.html:2881-2898`을 교체한다.

```js
function initThoughtsFeed() {
  feedLoaded = true;
  const feedEl = document.getElementById('thought-feed');
  feedEl.innerHTML = `<div class="hint">${t('common.loading')}</div>`;
  const q = query(collection(db, 'thoughts'), orderBy('createdAt', 'desc'), limit(50));
  onSnapshot(q, snap => {
    if (snap.empty) {
      feedEl.innerHTML = `<div class="hint">${t('sharing.no_thoughts')}</div>`;
      lastDoc = null;
      document.getElementById('thought-more-btn').style.display = 'none';
      return;
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    document.getElementById('thought-more-btn').style.display = snap.docs.length < 50 ? 'none' : 'inline-flex';

    snap.docChanges().forEach(change => {
      const id = change.doc.id;
      if (change.type === 'added') {
        if (document.getElementById('thought-' + id)) return; // already rendered (e.g. initial batch order)
        const emptyHint = feedEl.querySelector('.hint');
        if (emptyHint) emptyHint.remove();
        const html = thoughtCardHtml(id, change.doc.data());
        const beforeId = change.newIndex < feedEl.children.length ? feedEl.children[change.newIndex]?.id : null;
        if (beforeId) document.getElementById(beforeId).insertAdjacentHTML('beforebegin', html);
        else feedEl.insertAdjacentHTML('beforeend', html);
      } else if (change.type === 'modified') {
        patchThoughtCard(id, change.doc.data());
      } else if (change.type === 'removed') {
        delete thoughtsCache[id];
        document.getElementById('thought-' + id)?.remove();
      }
    });
  }, e => {
    feedEl.innerHTML = `<div class="hint">${t('sharing.load_failed')}</div>`;
  });
}
```

`change.newIndex`는 이 문서가 현재 스냅샷(정렬된 상태)에서 몇 번째
위치인지를 Firestore SDK가 알려주는 값이다 — 이걸로 "새 글을 정확히 그
순서(최신순) 자리에" 끼워 넣는다(항상 맨 앞이 아니다 — 동시에 여러 글이
추가되는 경우 순서가 섞일 수 있어서 index 기준으로 넣는다).

### 4-4. `patchThoughtCard()` — 필드 단위 패치 헬퍼 추가

`thoughtCardHtml()` 함수(`index.html:2721`) 바로 다음에 추가한다.

```js
function patchThoughtCard(id, th) {
  const prev = thoughtsCache[id];
  thoughtsCache[id] = th;
  const card = document.getElementById('thought-' + id);
  if (!card) return; // not currently rendered (e.g. scrolled past into "load more" territory)

  const textEl = document.getElementById('thought-text-' + id);
  if (textEl && !textEl.querySelector('textarea')) textEl.textContent = th.text; // skip while owner is mid-edit

  if (th.editedAt && !prev?.editedAt) {
    const timeEl = card.querySelector('.thought-time');
    if (timeEl && !timeEl.querySelector('.thought-edited')) {
      timeEl.insertAdjacentHTML('beforeend', ` <span class="thought-edited">${t('sharing.edited')}</span>`);
    }
  }

  const toggle = document.getElementById('thought-ctoggle-' + id);
  if (toggle) toggle.textContent = t('sharing.comment_count', {n: th.commentCount || 0, s: (th.commentCount === 1 ? '' : 's')});
}
```

`textEl.querySelector('textarea')` 체크는 지금 이 카드의 소유자가 편집
중(`editThought()`가 `<textarea>`로 바꿔치기한 상태)이면 텍스트를 덮어쓰지
않기 위한 가드다 — 남이 아니라 본인이 편집 중인 카드가 자기 자신의 저장
결과로 인해 스냅샷이 튀는 경우를 포함해서, 편집 중엔 항상 건드리지 않는다
(저장이 끝나면 `saveThoughtEdit()`가 직접 `textEl.textContent`를 정상
뷰로 되돌리므로 문제없다 — 5번 참고).

### 4-5. `postThought()` — 수동 렌더링 제거

`index.html:2916-2935`에서 `addDoc` 이후의 수동 DOM 삽입 부분을 제거한다
— `onSnapshot`의 `added` 핸들러가 알아서 그려준다.

```js
async function postThought() {
  const input = document.getElementById('thought-input');
  const text  = input.value.trim();
  if (!text || !nickname || !myUid) return;
  const btn = document.getElementById('thought-post-btn');
  btn.disabled = true;
  try {
    await addDoc(collection(db, 'thoughts'), {
      nickname, text, createdAt: serverTimestamp(), commentCount: 0, authorUid: myUid
    });
    input.value = '';
  } catch (e) {
    alert(t('sharing.post_failed', {msg: e.message}));
  } finally {
    btn.disabled = false;
  }
}
```

### 4-6. `saveThoughtEdit()` / `deleteThought()` — 수동 패치 제거

`index.html:2784-2815`에서 Firestore 쓰기 이후의 수동 DOM 조작을
제거한다 — 4-4의 `patchThoughtCard`/4-3의 `removed` 핸들러가 대신한다.
단, `deleteThought()`의 `confirm()`/버튼 비활성화/에러 처리는 그대로
남긴다(사용자 입력 확인과 네트워크 에러 안내는 실시간 렌더링과 무관한
로직이다).

```js
async function saveThoughtEdit(id) {
  const input = document.getElementById('thought-edit-input-' + id);
  const text  = input.value.trim();
  if (!text || !myUid) return;
  try {
    await updateDoc(doc(db, 'thoughts', id), { text, editedAt: serverTimestamp() });
    document.getElementById('thought-text-' + id).textContent = text; // exit edit mode immediately for the owner
  } catch (e) {
    alert(t('sharing.edit_failed', {msg: e.message}));
  }
}

async function deleteThought(id) {
  if (!myUid) return;
  if (!confirm(t('sharing.confirm_delete'))) return;
  const btn = document.getElementById('thought-del-' + id);
  if (btn) btn.disabled = true;
  try {
    await deleteDoc(doc(db, 'thoughts', id));
  } catch (e) {
    alert(t('sharing.delete_failed', {msg: e.message}));
    if (btn) btn.disabled = false;
  }
}
```

`saveThoughtEdit()`에 `document.getElementById('thought-text-'+id).textContent = text`
한 줄만 남긴 이유는, 저장 직후 곧바로 `<textarea>`를 일반 텍스트로
되돌려야 편집 모드가 끝나기 때문이다(4-4의 "편집 중이면 패치 건너뜀"
가드와 짝을 이룬다 — 이 줄이 없으면 본인 카드가 계속 `<textarea>`
상태로 남아 자기 자신의 스냅샷 갱신도 계속 무시된다).

### 4-7. 댓글 — `toggleComments()`를 `onSnapshot` 구독/해제로 전환

`index.html:2938-2955`를 교체한다. 패널을 펼 때 구독을 시작하고, 접을
때 구독을 해제해서(`commentListeners` 맵) 화면에 없는 패널까지 계속
리스너를 물고 있지 않게 한다.

```js
const commentListeners = {};

function toggleComments(thoughtId) {
  const box  = document.getElementById('thought-comments-' + thoughtId);
  const open = box.classList.toggle('open');
  if (open && !commentListeners[thoughtId]) {
    const listEl = document.getElementById('thought-clist-' + thoughtId);
    listEl.innerHTML = `<div class="hint" style="padding:.5rem 0">${t('common.loading')}</div>`;
    const q = query(collection(db, 'thoughts', thoughtId, 'comments'), orderBy('createdAt', 'asc'));
    commentListeners[thoughtId] = onSnapshot(q, snap => {
      listEl.innerHTML = snap.empty
        ? ''
        : snap.docs.map(d => commentItemHtml(thoughtId, d.id, d.data())).join('');
    }, e => {
      listEl.innerHTML = `<div class="hint" style="padding:.5rem 0">${t('sharing.comments_load_failed')}</div>`;
    });
  } else if (!open && commentListeners[thoughtId]) {
    commentListeners[thoughtId]();
    delete commentListeners[thoughtId];
  }
}
```

댓글 목록은 4-2에서 결정한 대로 패널 전체를 다시 그린다 — 매번
`commentsCache`에도 다시 채워지므로(`commentItemHtml` 내부에서 처리)
편집/삭제 버튼의 소유자 판별은 그대로 정확하다.

### 4-8. `postComment()` / `saveCommentEdit()` / `deleteComment()` — 수동 패치 제거

`index.html:2957-2975`, `2835-2879`에서 Firestore 쓰기 이후의 수동
DOM/캐시 조작을 제거한다 — 4-7의 댓글 리스너가 패널을 다시 그려주고,
`commentCount` 배지는 부모 글의 `onSnapshot`이 4-4를 통해 갱신해준다
(댓글을 달거나 지우면 `commentCount`가 바뀐 부모 `thoughts/{id}` 문서
자체도 `modified` 이벤트를 발생시키기 때문에 별도 코드 없이 이미
해결된다).

```js
async function postComment(thoughtId) {
  const input = document.getElementById('thought-cinput-' + thoughtId);
  const text  = input.value.trim();
  if (!text || !nickname || !myUid) return;
  try {
    await addDoc(collection(db, 'thoughts', thoughtId, 'comments'), {
      nickname, text, createdAt: serverTimestamp(), authorUid: myUid
    });
    await updateDoc(doc(db, 'thoughts', thoughtId), { commentCount: increment(1) });
    input.value = '';
  } catch (e) {
    alert(t('sharing.comment_failed', {msg: e.message}));
  }
}

async function saveCommentEdit(thoughtId, commentId) {
  const input = document.getElementById('comment-edit-input-' + commentId);
  const text  = input.value.trim();
  if (!text || !myUid) return;
  try {
    await updateDoc(doc(db, 'thoughts', thoughtId, 'comments', commentId), { text, editedAt: serverTimestamp() });
  } catch (e) {
    alert(t('sharing.edit_failed', {msg: e.message}));
  }
}

async function deleteComment(thoughtId, commentId) {
  if (!myUid) return;
  if (!confirm(t('sharing.confirm_delete'))) return;
  const btn = document.getElementById('comment-del-' + commentId);
  if (btn) btn.disabled = true;
  try {
    await deleteDoc(doc(db, 'thoughts', thoughtId, 'comments', commentId));
    await updateDoc(doc(db, 'thoughts', thoughtId), { commentCount: increment(-1) });
  } catch (e) {
    alert(t('sharing.delete_failed', {msg: e.message}));
    if (btn) btn.disabled = false;
  }
}
```

`saveCommentEdit()`는 이제 화면 갱신을 전혀 직접 하지 않는다 — 댓글
패널이 열려 있는 한 그 리스너가 곧바로 다시 그려주고, 이때 편집
텍스트박스는 자연히 원래 텍스트 뷰로 대체된다(댓글은 4-2에서 결정한
대로 패널 전체 재렌더 방식이라 카드처럼 "편집 중 스킵" 가드가 따로
필요 없다 — 재렌더 자체가 편집 모드 종료를 겸한다).

### 4-9. `loadMoreThoughts()`는 그대로 둔다

`index.html:2900-2914`(`getDocs` + `startAfter` 기반 "더 보기")는 손대지
않는다 — live 윈도우(최근 50개) 바깥의 과거 글은 실시간일 필요가 없고,
`lastDoc`은 4-3의 `onSnapshot` 콜백이 스냅샷을 받을 때마다 계속
갱신해주므로 live 윈도우가 시간에 따라 밀려도 "더 보기"가 정확히 그
경계 다음부터 이어진다.

## 5. 테스트 plan

- **(버그 수정 확인, 핵심)** 브라우저 A에서 닉네임 A로 등록 → Sources &
  Topics에서 URL 하나 추가 + 토픽 하나 끄기 → 새로고침 → 한 번도 안 쓴
  닉네임 B로 등록 → Sources & Topics 화면이 정확히 기본값(law360.com +
  courthousenews.com, 토픽 4개 전부 켜짐, 섹터/키워드/회사 비어있음)으로
  뜨는지 확인. Firestore 콘솔에서 `users/B` 문서를 직접 열어 A의 설정이
  전혀 안 섞여 있는지도 확인.
- 닉네임 A로 다시 새로고침 후 재로그인 → A의 원래 설정(URL 추가, 토픽
  끈 것)이 그대로 복원되는지(리셋이 기존 닉네임 재로그인에는 영향 없어야
  함 — `loadUserProfile`이 리셋 다음에 실행되므로).
- Archive Schedule(구 Daily Alarm) 시각도 같은 방식으로 닉네임 전환 시
  기본값(`08:00`)으로 리셋되고, 기존 닉네임 재로그인 땐 그 닉네임이
  저장한 시각으로 복원되는지.
- 언어는 의도적으로 안 건드렸으므로, 새 닉네임 등록 시 브라우저의
  마지막 언어를 그대로 물려받는 게(리셋 안 됨) 회귀가 아니라 의도된
  동작임을 확인만 하고 넘어간다.
- **(실시간 동기화 확인, 핵심)** 브라우저 A와 브라우저 B에서 각각 다른
  닉네임으로 동시 로그인 → A에서 새 글 작성 → B의 화면에 새로고침 없이
  그 글이 자동으로 나타나는지(정확한 위치에, 닉네임과 함께).
- A에서 자기 글을 수정 → B 화면에서 그 글의 텍스트와 "수정됨" 표시가
  자동으로 갱신되는지, 이때 B가 마침 다른 글의 댓글 패널을 열어둔
  상태였다면 그 패널이 접히지 않고 그대로 열려 있는지(4-2/4-4의 필드
  단위 패치 목적 검증).
- A에서 자기 글을 삭제 → B 화면에서 그 카드가 자동으로 사라지는지.
- A가 B의 글에 댓글을 달았을 때, B가 그 글의 댓글 패널을 열어둔 상태면
  자동으로 새 댓글이 나타나는지, 댓글 개수 배지도 같이 갱신되는지.
- A가 자기 댓글을 수정/삭제 → B가 그 패널을 열어둔 상태면 자동 반영되는지.
- 글쓴이 본인(A)이 직접 쓴/수정한/지운 글이 리스너를 거쳐서도 지연 없이
  자기 화면에 바로 반영되는지(낙관적 렌더링 제거 후 체감 속도 저하 없는지
  확인 — 4-2에서 예상한 대로 Firestore 로컬 캐시 덕분에 즉시 반영되는지).
- 50개 넘게 글이 쌓인 상태에서 "더 보기"를 눌러 과거 글을 불러온 뒤,
  누군가 새 글을 올려 live 윈도우가 한 칸씩 밀렸을 때 "더 보기"를 다시
  눌러도 중복/누락 없이 이어지는지.

## 6. 리스크 / 엣지케이스

**언어를 신규 닉네임 리셋 대상에서 뺀 이유** — 사용자의 요청 문구
("가입한 사람이 기존에 설정한 언어도 다음 로그인 했을 때 동일 언어로
보이도록")는 **기존** 닉네임의 언어 유지를 말한 것이고, 이미 그렇게
동작한다(2번 확인). 신규 닉네임까지 매번 사이트 기본 영어로 강제
리셋하면, 같은 컴퓨터를 쓰는 친구들이 전부 한국어 UI를 선호하는
상황에서 새 닉네임을 등록할 때마다 매번 영어로 돌아가는 게 오히려
불편한 회귀가 될 수 있다고 판단해서 그대로 뒀다. Sources/Topics(개인
설정 데이터)와 언어(브라우저 표시 환경설정)는 성격이 다르다고 봐서 이
경계를 뒀다 — 원하시면 3-1의 리셋 함수에 `applyLanguage('en')` 한 줄
추가하는 걸로 쉽게 바꿀 수 있다.

**live 피드가 상위 50개로 제한된 것의 한계** — 새 글이 계속 쌓이면
51번째로 밀려난 글은 live 리스너 범위 밖으로 빠지면서 "더 보기"를
눌러야 다시 보인다. 완전히 무제한 실시간 리스너를 걸면 이 문제는
없어지지만 글이 아주 많이 쌓였을 때 모든 클라이언트가 컬렉션 전체를
계속 구독하게 돼 비용·성능이 나빠진다. 친구들끼리 쓰는 소규모 앱
규모에서는 50개 제한이 합리적인 기본값이라고 판단해서 유지했다.

**댓글 편집 중 경합** — 내가 어떤 글의 댓글을 편집 중인데 그사이 같은
글에 다른 사람이 새 댓글을 달면, 4-2에서 결정한 대로 패널이 통째로
다시 그려지면서 내 편집 텍스트박스도 원래 텍스트로 되돌아간다(입력
중이던 수정 내용은 사라진다). 실사용 빈도가 낮은 경합이라 이번 범위에서
막지 않기로 했다 — 문제가 되면 4-4처럼 댓글에도 "편집 중이면 스킵"
가드를 추가하는 후속 작업으로 가능하다.

## 7. Self-review

**베스트 plan인지** — 설정 격리는 기존에 이미 있던 Auth 세션 리셋
블록에 리셋 호출 한 줄만 얹는 방식이라 최소 변경이다. 실시간 동기화는
낙관적 렌더링 코드를 별도로 유지하는 대신 `onSnapshot` 하나로 통합해서,
오히려 전체 코드량은 순수 추가가 아니라 상당 부분 삭제+통합이다(같은
렌더링 로직이 두 곳에 존재하지 않게 됨).

**빠진 게 있는지** — Archive Schedule(alarm times)도 같은 로컬 캐시
오염 패턴이라는 걸 확인해서 3번 범위에 포함시켰다. `commentCount`가
댓글 추가/삭제 시 부모 글 문서 자체의 `modified` 이벤트로 자동
갱신된다는 연결고리도 4-8에서 명시했다 — 이걸 놓쳤으면 배지 갱신
코드가 또 하나 필요했을 것이다.

**오버한 게 있는지** — 언어를 신규 닉네임 리셋 대상에 넣지 않은 것,
댓글 편집 경합을 필드 단위로 방어하지 않은 것, live 피드에 무제한
리스너를 걸지 않은 것 모두 요청 범위와 앱 규모에 맞춰 의도적으로
빼거나 단순화한 부분이다 — 6번에 각각 근거를 남겼다.

**테스트 충분한지** — 5번에 버그 수정 핵심 케이스, 기존 닉네임
재로그인 회귀, Archive Schedule 동일 적용, 실시간 동기화의 추가/수정/
삭제/댓글/배지 전 케이스, 그리고 "다른 카드 보고 있는 중에 안 접히는지"
같은 4-2의 설계 목적을 직접 검증하는 항목까지 포함했다. 다만 실시간
동기화는 브라우저 두 개를 동시에 띄워야 제대로 검증되는 특성상, 자동화
검증(Playwright 두 컨텍스트 동시 실행)으로 충분히 커버 가능하다고 본다.

## 8. 사용자 결정 필요 항목

없음 — 0번에서 이미 전부 자문을 거쳐 판단했다.
