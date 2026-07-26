// ═══════════════════════════════════════════════════════════════
// BTC-SMC-AI-StateEngine — Cloudflare Worker
// wrangler.jsonc의 assets.run_worker_first=["/api/*"] 설정으로 인해
// 이 fetch()는 /api/* 요청에서만 호출됨. 그 외 모든 요청(대시보드 HTML/CSS/JS)은
// 플랫폼이 정적 자산에서 직접 서빙 — Worker 미호출, 무료, 응답속도 영향 없음.
// ═══════════════════════════════════════════════════════════════

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/global';
const COINGECKO_CACHE_TTL = 60; // seconds — 기존 클라이언트 USDTD_POLL_MS(60000ms)와 동일 주기

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/coingecko' && request.method === 'GET') {
      return handleCoinGecko(request, env, ctx);
    }
    if (url.pathname === '/api/ai-analysis' && request.method === 'POST') {
      return handleAiAnalysis(request, env, ctx);
    }
    // ✅ [신규] WebSocket 중계기 (휴대폰 ↔ Colab)
    if (url.pathname === '/api/relay' && request.method === 'GET') {
      return handleRelay(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  }
};

// ── Phase 1: CoinGecko 캐싱 프록시 ──────────────────────────────
// 목적: 원본 코드 주석(index.html L1072-1076)에 명시된 리스크(무인증 5~15 calls/min,
// 전세계 공유·비보장, 다중 세션 시 조용히 차단 가능) 완화. 여러 탭/기기가 열려있어도
// 60s 캐시 윈도우당 업스트림 호출 1회로 줄어드는 것이 핵심 효과 — 단, 캐시 미스 시점의
// 개별 호출 자체가 CoinGecko 레이트리밋에 걸릴 가능성까지 없애주진 않음(Worker의 아웃바운드
// IP가 브라우저 직접호출보다 유리한지는 검증 안 됨. "해소"가 아니라 "완화"로 정정).
// COINGECKO_DEMO_API_KEY 시크릿이 없으면 무인증 엔드포인트로 자동 폴백 — 즉 이 시크릿은
// 필수가 아니라 선택(권장)이며, 없어도 이 라우트 자체는 정상 동작함.
// Cache API(caches.default) 사용 — Workers KV는 무료 티어 쓰기 1,000회/일로 제한되는데
// 60s 주기 갱신은 최대 1,440회/일이 필요해 KV로는 무료 티어를 초과함. Cache API는
// 이 제약이 없고 HTTP 캐싱 시맨틱에 정확히 맞는 용도라 이 경우엔 더 적합.
async function handleCoinGecko(request, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) {
    // 디버그용: cf-cache-status는 Cloudflare 자동 캐시 레이어 전용 헤더라 Cache API를
    // 수동으로 쓰는 이 경로엔 자동으로 안 붙을 수 있음 — 직접 헤더를 얹어 눈으로 확인 가능하게 함.
    // ResponseInit 스펙대로 status/statusText/headers를 명시적으로 꺼내 재구성(런타임의
    // 암묵적 동작에 의존하지 않기 위함).
    const headers = new Headers(cached.headers);
    headers.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  }

  const upstreamUrl = env.COINGECKO_DEMO_API_KEY
    ? `${COINGECKO_URL}?x_cg_demo_api_key=${env.COINGECKO_DEMO_API_KEY}`
    : COINGECKO_URL;

  try {
    const upstream = await fetch(upstreamUrl, { headers: { 'Accept': 'application/json' } });
    if (!upstream.ok) throw new Error(`CoinGecko HTTP ${upstream.status}`);

    const body = await upstream.text(); // 파싱 없이 그대로 통과 — 스키마 변형 리스크 제거,
                                         // 클라이언트의 기존 j.data.market_cap_percentage.usdt
                                         // 파싱 로직(index.html) 변경 불필요
    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${COINGECKO_CACHE_TTL}`,
        'X-Cache': 'MISS' // 캐시에도 이 값 그대로 저장됨 — HIT 경로에서 명시적으로 덮어씀
      }
    });

    ctx.waitUntil(cache.put(request, response.clone()));
    return response;

  } catch (err) {
    // 캐시 미스 + 업스트림 실패 = 여기 도달. 클라이언트의 기존 consecutiveFails/
    // STALE 백오프 로직(index.html)이 502를 그대로 실패로 처리하므로 별도 스텁 불필요.
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Phase 2: AI 분석 자동화 ──────────────────────────────────────
// 목적: copyAIAnalysis()의 클립보드→수동 붙여넣기 흐름을 서버사이드 호출로 대체(병행,
// 기존 버튼은 유지). ANTHROPIC_API_KEY는 `wrangler secret put ANTHROPIC_API_KEY`로
// 등록 — 클라이언트에 절대 노출되지 않음.
// "한글로 답변" 지시문은 클라이언트 문자열 결합 대신 system 프롬프트로 이전(중복 제거).
async function handleAiAnalysis(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const { narrative, vector } = payload || {};
  if (!narrative || !vector) {
    return new Response(JSON.stringify({ error: 'missing narrative/vector' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const userContent = narrative
    + '\n\n────────────────────────────────────\n[RAW VECTOR JSON]\n'
    + JSON.stringify(vector, null, 2);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // NOTE: 모델 식별자는 시간이 지나면 바뀔 수 있음 — 배포 전 docs.claude.com에서
        // 현재 유효한 모델 문자열인지 재확인 권장. 작성 시점(2026-07) 기준 claude-sonnet-5.
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: '당신은 BTC 선물 SMC(Smart Money Concepts) 트레이딩 분석 보조자입니다. ' +
                '항상 한국어로 답변하고, 확률적 표현을 사용하세요. 확정적 예측은 하지 마세요. ' +
                'DIRECTION, ENTRY QUALITY, CONFLICT LEVEL을 구분해서 결론을 제시하세요.',
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Anthropic API ${r.status}: ${errText.slice(0, 200)}`);
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return new Response(JSON.stringify({ text }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Phase 3: WebSocket Relay (휴대폰 ↔ Colab) ──────────────────
// 목적: 휴대폰 대시보드가 수집한 Binance 실시간 데이터를 Cloudflare Worker가 중계하여
// Colab(또는 다른 클라이언트)이 구독할 수 있도록 함. Worker는 Binance에 직접 접속하지
// 않으므로 지역 차단(451/403)을 회피할 수 있음.
//
// ⚠️ 주의사항 (엣지 케이스):
// 현재는 글로벌 Set을 사용하여 WebSocket 연결을 관리합니다. Cloudflare Workers는
// 단일 격리(Isolate) 내에서만 이 Set을 공유하므로, 여러 Worker 인스턴스가 뜨는 경우
// 연결이 분산될 수 있습니다. 하지만 개인용/소규모 테스트 용도로는 충분히 작동합니다.
// 대규모 배포 시에는 Durable Objects 도입을 고려하세요.
const clients = new Set();

async function handleRelay(request, env, ctx) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected WebSocket', { status: 400 });
  }

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  server.accept();
  clients.add(server);

  server.addEventListener('message', (event) => {
    // 연결된 모든 클라이언트(Colab 등)에게 메시지 브로드캐스트
    for (const clientSocket of clients) {
      if (clientSocket !== server && clientSocket.readyState === 1) {
        try {
          clientSocket.send(event.data);
        } catch (e) {
          // 전송 실패 시 해당 소켓은 무시 (조용히 넘어감)
        }
      }
    }
  });

  server.addEventListener('close', () => {
    clients.delete(server);
  });

  // 필요 시 연결 종료 처리를 위한 에러 핸들러
  server.addEventListener('error', (event) => {
    // console.warn('WebSocket error:', event);
    clients.delete(server);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
