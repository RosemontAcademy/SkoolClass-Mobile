# Phase 1 배포 체크리스트 — 돌아오면 이 순서대로

> 목표: 🧪 SkoolLink 알림테스트(또는 EduFinance 개별알림)로 보낸 푸시가 **SkoolClass 앱에서 실제로 울리는 것** 확인.
> 코드는 전부 준비됨. 아래는 사용자 손이 필요한 것들 + 최종 빌드.

## 1. Firebase에 Android 앱 추가 (5분, 콘솔)

skoollink 서버푸시 때 쓴 **같은 Firebase 프로젝트**에서:

1. Firebase 콘솔 → 프로젝트 설정 → 일반 → "앱 추가" → Android
2. 패키지 이름: `kr.rosemont.skoolclass` (정확히 이대로)
3. `google-services.json` 다운로드 → `E:\Projects\skoolclass-mobile\google-services.json`에 저장
4. Claude에게 "받았어" 라고 하면 app.json 연결 + 새 APK 빌드 진행

## 2. push_devices 테이블 생성 (SQL 에디터에서 1회 실행)

⚠️ 이 스니펫은 `DB_SKOOLCLASS_SCHEMA.sql`에 **이미 반영돼 있음** — 라이브엔 아래만 실행 (스키마 파일 통째 재실행 절대 금지):

```sql
CREATE TABLE IF NOT EXISTS public.push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT,
  app_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_devices_email_idx ON public.push_devices (email);
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
```

## 3. 엣지 펑션 배포 (대시보드, 2개)

| 펑션 | 정본 위치 | 내용 |
|---|---|---|
| `register-push-device` (신규) | `skoolclass-pro/supabase/functions/register-push-device/index.ts` | 앱이 토큰↔이메일 등록/해제 |
| `send-push` (수정) | `skoollink-pro/supabase/functions/send-push/index.ts` | 나쵸코드 + 자체 앱 이중 채널 fan-out |

기존 나쵸코드 발송 코드는 한 줄도 안 바뀜 — 자체 채널이 옆에 추가됐을 뿐 (안전).

## 4. E2E 테스트 순서

1. 새 APK 설치 (1번 후 Claude가 빌드 링크 줌) — **기존 개발 앱 삭제 후 설치 권장**
2. SkoolClass 앱 열고 위젯 로그인 → 하단 배너가 `push ok: (이메일)` 되는지 확인
   - `push ERR: ...`이 뜨면 그 내용 그대로 Claude에게
3. Supabase 대시보드에서 `select * from push_devices;` → 내 기기 행 1개 확인
4. SkoolLink staff 앱 🧪 알림테스트(또는 EduFinance 개별 미납 알림)로 그 이메일에 발송
5. **SkoolClass 앱에 알림 울리면 Phase 1 핵심 통과** 🎉
   - 나쵸코드 로즈몬트앱에도 여전히 울리는지 같이 확인 (이중 채널 검증)

## 준비된 코드 현황 (Claude가 이미 완료)

- ✅ `push_devices` 스키마 (DB_SKOOLCLASS_SCHEMA.sql 반영)
- ✅ `register-push-device` 엣지 펑션 (신규 작성)
- ✅ `send-push` 이중 채널 fan-out (+push_logs `[app]` 행, DeviceNotRegistered 자동 정리)
- ✅ 앱 셸: subscribe → 권한 요청 → Expo 토큰 발급 → 서버 등록 / unsubscribe → 행 삭제
- ✅ 알림 탭 딥링크 기초 (data.route → 위젯 쿼리 전달, 콜드/웜 스타트 모두)
- ⏳ 나머지 발송처 7곳 fan-out은 send-push E2E 통과 후 일괄 진행 (같은 헬퍼 복붙)
