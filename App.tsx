import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { registerDevice, topicToEmail, unregisterDevice } from './src/push';

// same-site 규칙: 위젯은 반드시 class.rosemont.kr에서 로드 (vercel.app 금지)
const WIDGET_URL = 'https://class.rosemont.kr/embed';
const INTERNAL_HOSTS = new Set(['class.rosemont.kr']);
const SHELL_VERSION = '1.2.1';

// 외부 URL 열기: http(s)는 Custom Tab(SFSafariViewController/Chrome Custom Tab —
// 앱 위에 시트로 얹혀서 풀 브라우저 앱 전환보다 덜 거슬리고, 구글 OAuth도 허용).
// tel:/mailto: 등은 OS 기본 처리.
const openExternal = (url: string) => {
  if (/^https?:/i.test(url)) {
    void WebBrowser.openBrowserAsync(url).catch(() => Linking.openURL(url).catch(() => {}));
  } else {
    void Linking.openURL(url).catch(() => {});
  }
};
// 위젯 로그인 키 스냅샷(iOS WebKit 7일 삭제 대비)이 저장되는 SecureStore 키
const LS_SNAPSHOT_KEY = 'widget_ls_snapshot';

// 앱이 포그라운드일 때도 알림 배너/사운드 표시
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false, // 뱃지는 위젯 안읽음 수(set-badge 브릿지)가 단일 소스
  }),
});

// 주입 스크립트 4역할:
//  ① 세션 복구 — SecureStore 스냅샷의 로그인 키를 localStorage에 되살림(있는 키는 안 덮음)
//  ② window.SkoolClassApp 1급 브릿지 (subscribePush/unsubscribePush/setBadge)
//  ③ window.Nachocode shim — 구버전 웹 호환용 (웹이 SkoolClassApp을 우선 감지)
//  ④ 로그인 키 주기 스냅샷 → 네이티브(SecureStore) 백업
const buildInjection = (restored: Record<string, string> | null) => `
(function () {
  if (window.__skoolclassShellReady) return;
  window.__skoolclassShellReady = true;
  var send = function (payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
  };
  try {
    var restored = ${JSON.stringify(restored ?? {})};
    for (var k in restored) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, restored[k]);
    }
  } catch (e) {}
  var AUTH_KEYS = ['skool_widget_token','skool_widget_student_id','skool_widget_role','skool_widget_email','skool_widget_children'];
  var snapshot = function () {
    try {
      var out = {};
      for (var i = 0; i < AUTH_KEYS.length; i++) {
        var v = localStorage.getItem(AUTH_KEYS[i]);
        if (v !== null) out[AUTH_KEYS[i]] = v;
      }
      send({ type: 'ls-snapshot', data: out });
    } catch (e) {}
  };
  window.SkoolClassApp = {
    version: '${SHELL_VERSION}',
    subscribePush: function (email) {
      send({ type: 'push-subscribe', topicName: String(email || '') });
      snapshot();
      return Promise.resolve({ ok: true });
    },
    unsubscribePush: function () {
      send({ type: 'push-unsubscribe' });
      return Promise.resolve({ ok: true });
    },
    setBadge: function (count) { send({ type: 'set-badge', count: count }); },
    // 소셜 로그인 완료 신호 — 셸이 Custom Tab을 자동으로 닫는다 (구셸에선 미존재 → 웹은 ?. 호출)
    notifySocialLoginDone: function () { send({ type: 'social-login-done' }); },
  };
  window.Nachocode = {
    env: { isApp: function () { return true; } },
    push: {
      subscribePushTopic: function (topicName) {
        return window.SkoolClassApp.subscribePush(topicName).then(function () {
          return { statusCode: 200, status: 'success' };
        });
      },
      unsubscribePushTopic: function () {
        return window.SkoolClassApp.unsubscribePush().then(function () {
          return { statusCode: 200, status: 'success' };
        });
      },
      getSubscriptionList: function () {
        return Promise.resolve({ statusCode: 200, status: 'success', list: [] });
      }
    }
  };
  setInterval(snapshot, 20000);
  window.addEventListener('pagehide', snapshot);
  setTimeout(snapshot, 5000);
  send({ type: 'shell-ready', url: location.href });
})();
true;
`;

type BridgeEvent =
  | { type: 'shell-ready'; url?: string }
  | { type: 'push-subscribe'; topicName?: string }
  | { type: 'push-unsubscribe'; topicName?: string }
  | { type: 'ls-snapshot'; data?: Record<string, string> }
  | { type: 'set-badge'; count?: number }
  | { type: 'social-login-done' };

const isInternalUrl = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'about:' || protocol === 'blob:' || protocol === 'data:') return true;
    return INTERNAL_HOSTS.has(hostname);
  } catch {
    return true; // 파싱 불가한 내부 스킴은 WebView에 맡김
  }
};

export default function App() {
  const webviewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  // undefined = SecureStore 읽는 중(WebView 렌더 보류), null = 스냅샷 없음
  const [restoredLS, setRestoredLS] = useState<Record<string, string> | null | undefined>(undefined);
  // PoC 검증용 배너: 브릿지 마지막 이벤트를 화면에 노출
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(LS_SNAPSHOT_KEY)
      .then((raw) => setRestoredLS(raw ? JSON.parse(raw) : null))
      .catch(() => setRestoredLS(null));
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let data: BridgeEvent | null = null;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!data?.type) return;

    switch (data.type) {
      case 'shell-ready':
        setLastEvent('shell-ready');
        break;
      case 'push-subscribe': {
        const email = topicToEmail(data.topicName ?? '');
        setLastEvent(`subscribe: ${email || '?'}`);
        if (!email) break;
        registerDevice(email)
          .then(() => setLastEvent(`push ok: ${email}`))
          .catch((err) =>
            setLastEvent(`push ERR: ${err instanceof Error ? err.message : String(err)}`),
          );
        break;
      }
      case 'push-unsubscribe':
        setLastEvent('unsubscribe');
        unregisterDevice().catch((err) => console.warn('[push] unregister failed', err));
        // 로그아웃 = 세션 스냅샷도 폐기 (다음 부팅에 로그인 상태 부활 방지)
        void SecureStore.deleteItemAsync(LS_SNAPSHOT_KEY).catch(() => {});
        void Notifications.setBadgeCountAsync(0).catch(() => {});
        break;
      case 'ls-snapshot':
        if (data.data && typeof data.data === 'object') {
          void SecureStore.setItemAsync(LS_SNAPSHOT_KEY, JSON.stringify(data.data)).catch(() => {});
        }
        break;
      case 'set-badge': {
        const count = Math.max(0, Math.floor(Number(data.count) || 0));
        void Notifications.setBadgeCountAsync(count).catch(() => {});
        break;
      }
      case 'social-login-done':
        // 위젯 폴링이 로그인 완료를 감지 → OAuth Custom Tab 닫기 시도.
        // ⚠️ Android 셀프 딥링크(skoolclass:// 자기 호출)로 탭을 덮는 트릭은 금지 —
        // 액티비티 재진입 크래시 실기기 확인(2026-07-17, v1.2.0 팅김 3사 공통 원인).
        // Android에서 dismissBrowser가 안 먹으면 사용자가 X로 닫는다(로그인은 유지됨).
        void WebBrowser.dismissBrowser().catch(() => {});
        break;
    }
  }, []);

  // 구글 OAuth 등 외부 네비게이션은 Custom Tab으로 (WebView 내부 진행 금지)
  const handleShouldStartLoad = useCallback((request: { url: string }) => {
    if (isInternalUrl(request.url)) return true;
    openExternal(request.url);
    return false;
  }, []);

  const handleNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    canGoBackRef.current = nav.canGoBack;
  }, []);

  // Android 하드웨어 뒤로가기 → WebView 히스토리 우선
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current) {
        webviewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  // 알림 탭 딥링크: data.route를 위젯 쿼리로 전달 (위젯 핸들러가 화면 전환)
  const navigateToRoute = useCallback((notifData: Record<string, unknown> | undefined) => {
    const route = typeof notifData?.route === 'string' ? notifData.route : '';
    if (!route) return;
    const params = new URLSearchParams({ route });
    for (const key of ['studentId', 'conversationId'] as const) {
      const value = notifData?.[key];
      if (typeof value === 'string' && value) params.set(key, value);
    }
    const target = `${WIDGET_URL}?${params.toString()}`;
    webviewRef.current?.injectJavaScript(
      `window.location.href = ${JSON.stringify(target)}; true;`,
    );
  }, []);

  useEffect(() => {
    // 웜 스타트: 앱 떠 있는 상태에서 알림 탭
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      navigateToRoute(response.notification.request.content.data as Record<string, unknown>);
    });
    // 콜드 스타트: 알림 탭으로 앱이 켜진 경우 (WebView 로드 시간을 기다렸다 주입)
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      if (data?.route) setTimeout(() => navigateToRoute(data), 4000);
    });
    return () => sub.remove();
  }, [navigateToRoute]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar style="auto" />
        {restoredLS !== undefined && (
          <WebView
            ref={webviewRef}
            source={{ uri: WIDGET_URL }}
            style={styles.webview}
            injectedJavaScriptBeforeContentLoaded={buildInjection(restoredLS)}
            onMessage={handleMessage}
            onShouldStartLoadWithRequest={handleShouldStartLoad}
            onOpenWindow={(event) => {
              // window.open (소셜 로그인 팝업 등) → Custom Tab
              const url = event.nativeEvent.targetUrl;
              if (url) openExternal(url);
            }}
            onNavigationStateChange={handleNavigationStateChange}
            domStorageEnabled
            javaScriptEnabled
            sharedCookiesEnabled
            allowsBackForwardNavigationGestures
            // 위젯 TTS/사운드는 사용자 제스처 없이도 재생돼야 함
            mediaPlaybackRequiresUserAction={false}
          />
        )}
        {lastEvent !== null && (
          <View style={styles.debugBanner}>
            <Text style={styles.debugText} numberOfLines={1}>
              bridge: {lastEvent}
            </Text>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F1117',
  },
  webview: {
    flex: 1,
  },
  debugBanner: {
    position: 'absolute',
    bottom: 40, // 안드로이드 제스처 바에 가려지지 않게
    left: 8,
    right: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(15, 17, 23, 0.85)',
  },
  debugText: {
    color: '#4ade80',
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
