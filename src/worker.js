// ═══════════════════════════════════════════════════════════════
// BTC-SMC-AI-StateEngine — Cloudflare Worker (Gemini API)
// ═══════════════════════════════════════════════════════════════

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/global';
const COINGECKO_CACHE_TTL = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/coingecko' && request.method === 'GET') {
      return handleCoinGecko(request, env, ctx);
    }
    if (url.pathname === '/api/ai-analysis' && request.method === 'POST') {
      return handleAiAnalysis(request, env, ctx);
    }
    if (url.pathname === '/api/relay' && request.method === 'GET') {
      return handleRelay(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  }
};

// ── Phase 1: CoinGecko 캐싱 프록시 ──────────────────────────────
async function handleCoinGecko(request, env, ctx) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) {
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

    const body = await upstream.text();
    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${COINGECKO_CACHE_TTL}`,
        'X-Cache': 'MISS'
      }
    });

    ctx.waitUntil(cache.put(request, response.clone()));
    return response;

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Phase 2: AI 분석 자동화 (Gemini API) ──────────────────────
async function handleAiAnalysis(request, env, ctx) {
  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { narrative, vector } = payload || {};
  if (!narrative || !vector) {
    return new Response(JSON.stringify({ error: 'missing narrative/vector' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const userContent = narrative
    + '\n\n────────────────────────────────────\n[RAW VECTOR JSON]\n'
    + JSON.stringify(vector, null, 2);

  // ── Gemini 모델 선택 ──────────────────────────────────────────
  // ✅ 현재 활성화된 모델: gemini-2.5-flash (가장 최신, 빠름, 추천)
  const GEMINI_MODEL = 'gemini-2.5-flash';
  // const GEMINI_MODEL = 'gemini-2.0-flash';   // 안정적
  // const GEMINI_MODEL = 'gemini-2.5-pro';     // 더 정밀 (속도 느림)
  // const GEMINI_MODEL = 'gemini-flash-latest'; // 최신 Flash
  // const GEMINI_MODEL = 'gemini-pro-latest';   // 최신 Pro
  // ──────────────────────────────────────────────────────────────

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  try {
    const r = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: '당신은 BTC 선물 SMC(Smart Money Concepts) 트레이딩 분석 보조자입니다. ' +
                  '항상 한국어로 답변하고, 확률적 표현을 사용하세요. 확정적 예측은 하지 마세요. ' +
                  'DIRECTION, ENTRY QUALITY, CONFLICT LEVEL을 구분해서 결론을 제시하세요.'
          }]
        },
        contents: [{
          parts: [{ text: userContent }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1500,
        }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Gemini API ${r.status}: ${errText.slice(0, 200)}`);
    }

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '(빈 응답)';

    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── Phase 3: WebSocket Relay (휴대폰 ↔ Colab) ──────────────────
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
    for (const clientSocket of clients) {
      if (clientSocket !== server && clientSocket.readyState === 1) {
        try { clientSocket.send(event.data); } catch (e) {}
      }
    }
  });

  server.addEventListener('close', () => {
    clients.delete(server);
  });

  server.addEventListener('error', () => {
    clients.delete(server);
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
