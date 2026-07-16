import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { registerDevice, topicToEmail, unregisterDevice } from './src/push';

// 앱이 포그라운드일 때도 알림 배너/사운드 표시
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// same-site 규칙: 위젯은 반드시 class.rosemont.kr에서 로드 (vercel.app 금지)
const WIDGET_URL = 'https://class.rosemont.kr/embed';
const INTERNAL_HOSTS = new Set(['class.rosemont.kr']);

// PoC 단계 브릿지: 위젯의 nachocode.ts Direct 모드가 기대하는 window.Nachocode를
// 그대로 흉내낸다 (웹 코드 무수정). Phase 1에서 window.SkoolClassApp 1급 브릿지로 승격.
// 주의: 반환값은 위젯 isOkResult 통과 형태여야 함 — status:'error'/statusCode 203 금지.
const NACHOCODE_SHIM = `
(function () {
  if (window.__skoolclassShellReady) return;
  window.__skoolclassShellReady = true;
  var send = function (payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
  };
  window.Nachocode = {
    env: { isApp: function () { return true; } },
    push: {
      subscribePushTopic: function (topicName) {
        send({ type: 'push-subscribe', topicName: topicName });
        return Promise.resolve({ statusCode: 200, status: 'success' });
      },
      unsubscribePushTopic: function (topicName) {
        send({ type: 'push-unsubscribe', topicName: topicName });
        return Promise.resolve({ statusCode: 200, status: 'success' });
      },
      getSubscriptionList: function () {
        return Promise.resolve({ statusCode: 200, status: 'success', list: [] });
      }
    }
  };
  send({ type: 'shell-ready', url: location.href });
})();
true;
`;

type BridgeEvent =
  | { type: 'shell-ready'; url?: string }
  | { type: 'push-subscribe'; topicName?: string }
  | { type: 'push-unsubscribe'; topicName?: string };

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
  // PoC 검증용 배너: shim이 위젯에서 받은 마지막 이벤트를 화면에 노출
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let data: BridgeEvent | null = null;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!data?.type) return;

    console.log('[bridge]', data);
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
        setLastEvent(`unsubscribe: ${data.topicName ?? '?'}`);
        unregisterDevice().catch((err) => console.warn('[push] unregister failed', err));
        break;
    }
  }, []);

  // 알림 탭 딥링크: data.route를 위젯 쿼리로 전달 (§4.5 — 위젯 측 핸들러는 웹 배포로 추가 예정)
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

  // 구글 OAuth 등 외부 네비게이션은 시스템 브라우저로 (WebView 내부 진행 금지)
  const handleShouldStartLoad = useCallback((request: { url: string }) => {
    if (isInternalUrl(request.url)) return true;
    void Linking.openURL(request.url).catch(() => {});
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

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar style="auto" />
        <WebView
          ref={webviewRef}
          source={{ uri: WIDGET_URL }}
          style={styles.webview}
          injectedJavaScriptBeforeContentLoaded={NACHOCODE_SHIM}
          onMessage={handleMessage}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onOpenWindow={(event) => {
            // window.open (소셜 로그인 팝업 등) → 시스템 브라우저
            const url = event.nativeEvent.targetUrl;
            if (url) void Linking.openURL(url).catch(() => {});
          }}
          onNavigationStateChange={handleNavigationStateChange}
          domStorageEnabled
          javaScriptEnabled
          sharedCookiesEnabled
          allowsBackForwardNavigationGestures
          // 위젯 TTS/사운드는 사용자 제스처 없이도 재생돼야 함
          mediaPlaybackRequiresUserAction={false}
        />
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
