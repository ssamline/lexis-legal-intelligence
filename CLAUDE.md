# Lex.Almonds 프로젝트 CLAUDE.md

이 파일은 프로젝트 루트에 두는 project-level CLAUDE.md 다. user-level CLAUDE.md 룰 위에 이 프로젝트 특화 룰이 추가된다.

## 스토리 직접 조사 기능 (Personal Tool → Search Stories)

`index.html`의 `#sub-search` 안에 "스토리 직접 조사" 카드가 있다. 사용자가 기사 URL을 붙여넣거나 이미지를 업로드하면 두 가지 조사 유형(요약 / 내가 추적하는 기업·업종에 대한 영향 조사) 중 하나를 선택해서 서버가 Claude API를 호출해 그 자리에서 분석 결과를 보여준다. 별도 배포 과정이나 정적 페이지 없이, 이 SPA 안에서 완전히 무료로(사이트 운영자의 기존 `ANTHROPIC_API_KEY` 사용량 안에서) 동작하도록 설계됐다.

### 핵심 설계 원칙 — 새 조사 유형을 추가하거나 이 기능을 수정할 때 지킬 것

- **서버가 프롬프트를 고정한다.** `/api/story-research`(`server.js`)는 `/api/compare-companies`와 동일한 패턴을 따른다 — 클라이언트는 조사 유형과 원본(URL 또는 이미지)만 보내고, system 프롬프트는 서버 코드에 하드코딩돼 있다. `/api/chat`처럼 클라이언트가 임의의 system/model을 보내는 범용 프록시 패턴은 이 기능에 쓰지 않는다(비용·프롬프트 인젝션 통제 목적).
- **비용 상한을 유지한다.** 기사 본문은 6000자로 잘라서 보내고, 이미지는 5MB로 제한한다. 새 조사 유형을 추가해도 이 상한을 벗어나지 않게 한다.
- **rate limit을 건드릴 때 신중하게.** `server.js`의 in-memory `rateHits` 맵이 IP당 시간당 요청 수를 제한한다. `app.set('trust proxy', true)`가 설정돼 있어야 Render 프록시 뒤에서도 `req.ip`가 실제 클라이언트 IP를 가리킨다 — 이 설정을 제거하면 rate limit이 사실상 무의미해진다.
- **응답은 항상 JSON 형식을 강제한다.** system 프롬프트 끝에 "Respond ONLY as valid JSON" 지시를 넣고, 응답 파싱은 정규식으로 첫 `{...}` 블록만 추출하는 기존 패턴(`compare-companies`, `story-research` 공통)을 그대로 따른다.
- **모델은 `claude-haiku-4-5-20251001`을 기본으로 유지한다.** 비용 효율을 위해 이 프로젝트의 다른 AI 기능(`/api/compare-companies`, trend analysis)과 동일한 모델을 쓴다. 더 강력한 모델이 필요한 특수 케이스가 아니면 바꾸지 않는다.
- **인증은 이미 앱 전체에 걸려 있다.** `#start-gate`(닉네임+비밀번호)를 통과하지 않으면 `#app-root` 자체가 안 보이므로, 이 기능에 별도 로그인 체크를 추가할 필요는 없다.

### 새 조사 유형을 추가하고 싶을 때

1. `/api/story-research`의 `researchType` 분기에 새 case 추가 + 그 유형만의 system 프롬프트 작성(JSON 스키마 명시).
2. 프론트엔드에 버튼 하나 추가하고 `runStoryResearch('새유형')` 연결.
3. 결과 렌더링은 기존 `.biz-card`/`.compare-card`/`.risk-badge` CSS를 재사용 — 새 유형 전용 CSS를 새로 만들기 전에 기존 클래스로 표현 가능한지 먼저 확인한다.
