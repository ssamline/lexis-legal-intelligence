# Plan: Fix Daily Briefing's 편중된 섹터 태깅 + Compare Companies 회사별 조사 신뢰도

## 1. 문제 정의

### 1-1. Daily Briefing의 biz(기회/위험) 항목이 실제 법률 분야와 무관하게 항상 같은 업종으로 태깅됨

사용자가 보고한 증상: "어떤 분야건 법령이건 상관없이 finance & banking에 대해서만 나오네."

`server.js`의 `/api/generate-briefing` 핸들러(415~417번째 줄)를 확인한 결과, 원인은 다음과 같다.

```js
let bizInstr = ` For each section include a "biz" array of 1-2 opportunities and 1-2 risks directly tied to that section's legal developments.`;
if (sectors.length) bizInstr += ` Business sectors: ${sectors.join(', ')}.`;
bizInstr += ` Each biz item: {type:"opportunity"|"risk",company:"",sector:"name or empty",text:"1-2 sentences"}. ...`;
```

사용자가 설정한 Business Sectors(예: Finance & Banking)가 IP/규제/소송/기업 등 4개 토픽 섹션 전체에 동일하게 한 번만 주입된다. 섹션이 어떤 법률 분야를 다루든 상관없이 "Business sectors: Finance & Banking"이라는 문맥이 항상 붙기 때문에, 모델이 관련성과 무관하게 그 섹터를 biz 항목에 반복해서 태깅하게 된다.

### 1-2. Compare Companies의 회사별 병렬 조사가 일부 회사에서 자주 실패함

오늘 세션 중 병렬-per-company 구조로 전환한 뒤 실제 라이브 테스트에서 확인된 패턴: 도요타(Toyota)는 반복 테스트에서 항상 성공했지만, 포드(Ford)·Agilent는 반복적으로 200초 타임아웃에 걸려 실패했다. 사용자는 "하나의 루트로" 되돌려서 재설계해달라고 요청했다.

다만 오늘 직접 확인한 증거상, 되돌리려는 "하나의 루트"(회사 여러 개를 한 Claude 호출 안에서 순차적으로 조사)는 이미 이전에 여러 번 테스트했고 회사 2개만 돼도 280초+ 안에 끝나지 않는 것을 반복 확인했다(`plan_global_legal_research.md` 이후 커밋 히스토리 참고 — `f31294b`, `ee075d5`, `831b877` 등). 단일 루트로 되돌리면 지금의 "일부 회사 실패"보다 더 나쁜 "전체 실패"로 돌아갈 가능성이 높다.

## 2. 범위

### 2-1. bizInstr을 토픽별 연관성 기반으로 수정 ✅

일반 섹션(Haiku, 툴 없음)의 biz 지시문을, 섹터를 무조건 붙이는 대신 "그 섹션의 법률 발전과 실제로 연관 있을 때만" 태깅하도록 명시적으로 바꾼다:

```
For each section include a "biz" array of 1-2 opportunities and 1-2 risks directly tied to that section's own legal developments — not a generic business summary.
${sectors.length ? `The user tracks these business sectors: ${sectors.join(', ')}. Only tag a biz item with one of these sectors if THIS SPECIFIC section's legal development genuinely and specifically affects that sector — do not force-fit an unrelated sector onto unrelated legal news. If no tracked sector is relevant to this section, leave "sector" empty.` : ''}
Each biz item: {type:"opportunity"|"risk",company:"",sector:"name or empty",text:"1-2 sentences"}.
```

이건 `/api/generate-briefing`의 `bizInstr` 문자열 하나만 수정하면 되는 국소적 변경이다.

### 2-2. 회사별 조사에 실패 시 1회 자동 재시도 추가 ✅

`researchCompanyIntel`(generate-briefing용)과 `researchCompareCompanyIntel`(compare-companies용) 둘 다에, 최초 호출이 실패(`error` 필드가 있는 결과)하면 **한 번만 자동으로 재시도**하는 로직을 추가한다. 각 회사 호출은 이미 독립적으로 병렬 실행되므로, 재시도가 필요한 회사만 추가로 한 번 더 시도해도 전체 요청의 지연 시간에 미치는 영향은 제한적이다(재시도 안 하는 회사들은 그대로 끝나 있음).

재시도 호출은 첫 시도(200초)보다 짧은 타임아웃(100초)으로 실행한다. 첫 시도가 실패하는 이유가 대부분 200초 자체 타임아웃이었으므로, 재시도까지 똑같이 200초를 주면 그 회사 하나 때문에 전체 응답이 최대 400초까지 늘어날 수 있다 — 이건 사용자 대기 경험상 너무 길다. 100초로 줄이면 최악의 경우도 약 300초(200+100)로 억제되고, 재시도는 "완전히 새로 놓치는 것보다 낫다"는 보너스 시도이므로 짧게 줘도 합리적이다.

이렇게 하는 이유(단일 루트로 되돌리지 않는 이유)를 사용자에게 명확히 설명: 단일 루트는 오늘 반복 검증한 결과 회사 2개만 돼도 완전히 실패하는 빈도가 더 높았다. 병렬 + 재시도는 지금의 구조(빠르고, 부분 실패 시에도 나머지는 살아남음)를 유지하면서, 재시도로 완주율만 높이는 방향이 실제로 사용자가 원하는 "회사 둘 다 나오는 비교"에 더 가깝다.

재시도 시에도 실패하면 지금처럼 `error` 필드를 유지해 해당 회사만 빠지고(compare-companies의 경우) 또는 companyIntelErrors에 남고(generate-briefing의 경우), 나머지는 정상 진행한다 — 이 그레이스풀 디그레이데이션은 그대로 유지.

**비용 참고**: 재시도가 실제로 발동하는 회사에 한해 Anthropic API 호출이 1회 추가되므로, 그 회사분의 비용이 두 배가 된다(전체 요청이 아니라 실패한 회사 건에 한정). 오늘 실측한 실패율을 고려하면 일부 요청에서만 발생하는 소폭 추가 비용이라 rate limit(compare-companies 10회/시간, generate-briefing 30회/시간)로 이미 상한이 걸려 있다.

### 2-3. 로컬 검증 + 라이브 검증

- 로컬: syntax 체크, ANTHROPIC_API_KEY 없는 상태에서 기존 400/500 검증 경로가 안 깨졌는지 확인.
- 라이브: Thermo Fisher Scientific + Agilent Technologies 두 회사로 Compare Companies를 다시 돌려서, 재시도 로직 덕분에 두 회사 모두(또는 최소한 이전보다 높은 확률로) 데이터가 채워지는지 확인. Daily Briefing도 사용자가 실제 쓰는 회사 조합으로 한 번 더 확인.
- Finance & Banking 태깅: IP나 소송처럼 금융과 무관한 토픽 섹션에서 더 이상 무조건 Finance & Banking이 안 나오는지 실제 생성 결과로 확인.

## 3. 영향받는 코드

- `server.js`
  - `/api/generate-briefing`의 `bizInstr` 문자열 (415~417번째 줄 부근)
  - `researchCompanyIntel` 함수 — 재시도 로직 추가
  - `researchCompareCompanyIntel` 함수 — 재시도 로직 추가
- `index.html`: 변경 없음 (응답 스키마는 그대로 유지되므로 클라이언트 코드는 안 건드림)

## 4. 사용자 결정 필요 항목

없음 — 재시도 방향은 오늘 확보한 명확한 증거(단일 루트가 더 나쁘게 실패했다는 반복 실측)에 기반한 기술적 판단이라 인터뷰 없이 이 plan에 반영. 다만 이 방향으로 가는 것에 동의하시는지만 확인 부탁드립니다(원래 "하나의 루트로"라고 명시적으로 요청하셨던 부분과 다른 방향이라서요).

## 5. Self-review

- **베스트인가**: 단일 루트 완전 복귀보다, 오늘 실측 근거(단일 루트 = 반복적 전체 실패, 병렬 = 부분 성공)를 반영한 "병렬 유지 + 재시도"가 사용자의 실제 목표(회사 둘 다 나오는 비교)에 더 잘 맞는다고 판단.
- **빠진 거 없는지**: bizInstr 수정은 generate-briefing에만 있고 compare-companies에는 애초에 이런 섹터 블랭킷 태깅 구조가 없어서(개별 회사 조사가 항상 그 회사 이름으로 태깅됨) 해당 없음 — 확인 완료.
- **오버한 거 없는지**: 재시도는 "실패 시 1회만" — 무한 재시도나 재시도마다 더 강한 모델/파라미터를 쓰는 등의 확장은 넣지 않음(오버엔지니어링 방지).
- **테스트 충분한지**: 로컬 syntax + 실제 라이브 2개 시나리오(compare-companies 완주율, biz 섹터 태깅 정확도)로 검증 예정. 재시도로도 100% 완주를 보장하진 못하므로(오늘 본 실패율 자체가 확률적) 완전한 보장은 없다는 점을 사용자에게도 명시.

확신도: 90%. bizInstr 수정은 코드 근거가 명확해 확신 높음. 재시도가 실제로 완주율을 얼마나 개선할지는 라이브에서 확인해야 아는 부분(오늘 이미 많은 API 비용을 썼으므로 검증은 최소 횟수로 진행).
