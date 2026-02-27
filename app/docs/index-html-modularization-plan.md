# index.html 분리 제안

## 결론
현재 `app/index.html`은 UI 골격을 한 파일에 모아둔 상태라 초기 개발에는 빠르지만, 탭이 5개(`Environment`, `Downloads`, `YouTube DB`, `Organizer`, `ReNamer`)로 늘어난 지금 시점에서는 **분리하는 편이 유지보수에 유리**합니다.

## 왜 지금 분리가 필요한가
- `app/index.html`이 이미 390줄 규모라서 특정 탭만 수정할 때도 전체 파일 컨텍스트를 계속 읽어야 합니다.
- `id`/`class` 셀렉터가 탭별로 많아 충돌 가능성이 올라가고, 코드리뷰 범위도 불필요하게 커집니다.
- `app/src/main.js`(1605줄)에서 DOM 바인딩을 다루는 구조와 결합되면 기능 단위 추적이 어려워집니다.

## 권장 분리 방식 (Vite 기준)
1. `index.html`은 최소 Shell만 유지
   - Header
   - Main tab bar
   - `<main id="tabHost"></main>` 같은 탭 마운트 포인트
2. 탭별 Markup을 `src/ui/tabs/*.js`로 분리
   - `renderServerTab()`
   - `renderDownloadsTab()`
   - `renderSqliteTab()`
   - `renderOrganizerTab()`
   - `renderRenamerTab()`
3. 이벤트 바인딩도 탭 단위로 묶기
   - `src/features/server/bindServerEvents.js`
   - `src/features/downloads/bindDownloadEvents.js`
4. 공통 컴포넌트(예: card header, modal)는 `src/ui/components/`로 재사용

## 적용 순서 (리스크 최소화)
1. **1차**: Markup만 함수로 옮기고 기존 `id`는 유지 (동작 변화 없음)
2. **2차**: 탭별 이벤트 바인딩 분리
3. **3차**: 공통 UI 조각 추출 + E2E/수동 점검

## 기대 효과
- 탭 단위 수정 시 파일 탐색 비용 감소
- 리뷰 단위가 작아져 회귀 위험 감소
- 신규 기능 추가 시 파일 구조 예측 가능성 향상
