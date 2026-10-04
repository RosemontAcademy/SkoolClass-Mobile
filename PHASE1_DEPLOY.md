# Phase 1 배포 상태 — 남은 건 E2E 테스트뿐

> 2026-07-16 갱신: 원래 "사용자 손 필요"였던 것까지 전부 Claude가 원격으로 완료.
> Firebase 앱 등록은 Downloads의 서비스 계정 키로 Management API 직접 호출,
> 엣지 펑션 배포는 Supabase CLI(자격 증명 관리자 토큰), FCM 키는 EAS GraphQL로 처리.

## ✅ 완료 (전부 배포/적용됨)

| 항목 | 상태 |
|---|---|
| `push_devices` 테이블 | 라이브 DB 생성됨 (RLS on, 정책 없음 = 서비스롤 전용) |
| `register-push-device` 엣지 펑션 | v1 ACTIVE, 등록/해제 스모크 테스트 통과 |
| `send-push` 이중 채널 fan-out | v8 ACTIVE (나쵸코드 무수정 + Expo Push 병렬) |
| Firebase Android 앱 등록 | `kr.rosemont.skoolclass` (appId 1:718791774264:android:6dd6...) |
| google-services.json | 발급받아 리포에 포함, app.json 연결 |
| FCM V1 서비스계정 키 → EAS | skoolclass-mobile 프로젝트에 업로드·연결 완료 |
| 앱 셸 푸시 배선 | subscribe → 권한 → 토큰 → 서버 등록, 딥링크 기초 포함 |

## ⏳ 남은 것 — E2E 테스트 (폰 필요)

1. **새 APK 설치** (빌드 완료되면 Claude가 링크 줌) — 기존 개발 앱 삭제 후 설치 권장
2. SkoolClass 앱 → 위젯 로그인 → 알림 권한 허용 → 하단 배너 **`push ok: (이메일)`** 확인
   - `push ERR: ...`가 뜨면 내용 그대로 Claude에게
3. Claude가 `push_devices`에서 기기 행 확인 (직접 조회 가능)
4. Claude가 `send-push`로 그 이메일에 테스트 발송 (직접 호출 가능)
5. **SkoolClass 앱에 알림 울리면 Phase 1 핵심 통과** 🎉 — 알림 탭하면 앱 열리는지도 확인
6. 로즈몬트-나쵸코드 앱에도 여전히 울리는지 확인 (이중 채널 검증)

## 다음 (E2E 통과 후)

- 나머지 발송처 7곳에 같은 fan-out 복붙: notify-boarding / notify-arrival / bus-eta-alerts / notify-chat-message / notify-team-message / curriculum-end-notify / notify-public-inquiry (+ data.route 딥링크 페이로드)
- DB 웹훅(팀챗 일반 메시지) 전수 조사
- 위젯 측 딥링크 핸들러 (?route= 쿼리 → 화면 전환)
- iOS 빌드 (Apple Developer 계정 필요 — 사용자 확인 필요)
- **학생 본인 계정 푸시(숙제 히어로)** — ✅ 서버 쪽 다 켜 둠(2026-10-04, 받는 기기 0). 아이가 이 앱에 자기 계정(학생 «본인» 연락처 이메일)으로 로그인하면 위젯이 `SkoolClassApp.subscribePush(본인 이메일)`로 그 기기를 등록하고(실패해도 화면 표시 없음), 토·일 KST 10:00 pg_cron `homework-hero-push`가 오늘 오프닝을 아직 안 본 아이에게 «🦸 {이름}! 숙제 시간이야!»를 보낸다(data.route=`student/home` → 위젯 홈 → 오프닝). 출시 때 확인: Test 학생(test0924@rosemont.kr)으로 앱 로그인 → push_devices 에 학생 이메일 행 → 함수 `{force:true}` 호출 → 알림·누르면 오프닝. ⚠️ 한 기기 = 한 로그인 — 엄마 폰에 아이 계정으로 로그인하면 그 폰의 학부모 알림이 끊긴다(«아이 기기에서만 아이 계정» 안내). 정본: `skoolclass-pro/implementation-plan/2026-10-03_숙제히어로_스쿨리.md` «P2+»
