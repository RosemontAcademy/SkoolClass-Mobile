import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

// 4개 프로젝트 공유 Supabase (anon 키는 웹 번들에도 노출되는 공개 키)
const SUPABASE_URL = 'https://ltkcajbmfdwjucmgniez.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx0a2NhamJtZmR3anVjbWduaWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4OTEyMjAsImV4cCI6MjA4NjQ2NzIyMH0.gjjRDG4mqZ_6xRzyyTV0dCfy8QNTtn019sI3o2Cu5nc';
const REGISTER_FN_URL = `${SUPABASE_URL}/functions/v1/register-push-device`;

// 위젯 nachocode.ts가 토픽명을 percent-encode한 소문자 이메일로 보냄 (user%40example.com)
// → 사람이 읽는 원형으로 복원해서 서버에 넘긴다 (서버도 한 번 더 정규화함)
export const topicToEmail = (topicName: string) => {
  const clean = (topicName ?? '').trim().toLowerCase();
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
};

let cachedToken: string | null = null;

async function getPushToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: '알림',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted) {
    const asked = await Notifications.requestPermissionsAsync();
    granted = asked.granted;
  }
  if (!granted) throw new Error('알림 권한 거부됨');

  const projectId: string | undefined =
    Constants?.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  cachedToken = token;
  return token;
}

async function callRegisterFn(body: Record<string, unknown>) {
  const res = await fetch(REGISTER_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// 위젯 로그인 → subscribe 이벤트에서 호출. 토큰 발급 + push_devices 등록.
export async function registerDevice(email: string): Promise<string> {
  const token = await getPushToken();
  await callRegisterFn({
    action: 'register',
    email,
    expoPushToken: token,
    platform: Platform.OS,
    appVersion: Constants?.expoConfig?.version ?? null,
  });
  return token;
}

// 위젯 로그아웃 → unsubscribe 이벤트에서 호출. 이 기기 행 삭제.
// 토큰이 캐시에 없으면(앱 재시작 직후 로그아웃 등) 권한이 이미 있을 때만 조용히 발급 시도.
export async function unregisterDevice(): Promise<void> {
  let token = cachedToken;
  if (!token) {
    const perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) return; // 권한 없으면 등록된 적도 없음
    token = await getPushToken().catch(() => null);
  }
  if (!token) return;
  await callRegisterFn({ action: 'unregister', expoPushToken: token });
}
