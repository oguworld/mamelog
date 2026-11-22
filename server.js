require('dotenv').config();
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3011;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// 個人データ(豆・日々のメモ・写真)はサーバーに一切保存しない(端末内IndexedDBのみ、CLAUDE.md参照)。
// このサーバーの唯一の役割は /api/identify によるAI自動入力の中継。
if (!ANTHROPIC_API_KEY) {
  console.warn(
    '[警告] ANTHROPIC_API_KEY が .env に設定されていません。' +
      ' /api/identify は常にエラーを返します(他の機能には影響しません)。'
  );
}

// sw.jsはブラウザのService Worker更新検知を妨げないよう、明示的にキャッシュ無効化ヘッダーを付与する
// (sg-weekend-app/sg-bus-naviと同じ前例を踏襲)。
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

// 画像(data URL、base64)を本文に含むリクエストのための上限。
// SPEC上の画像サイズ上限は約8MB、base64化で約1.37倍に膨らむため余裕を見て12mbとする。
app.use(express.json({ limit: '12mb' }));

/* ══════════════════════════════════════════════
 * CORS(iOSネイティブアプリ/Capacitor・Web版からのクロスオリジンfetch許可)
 * sg-weekend-app/sg-bus-naviと同じ許可オリジンリストの考え方を踏襲。
 * ══════════════════════════════════════════════ */
const ALLOWED_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://coffee.willoa.net',
];
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// /api/identifyは画像送信+AI呼び出しを伴う重い処理のため、他のエンドポイントより厳しく制限する。
const identifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // SPEC §4: 画像サイズ上限 約8MB

const ROAST_VALUES = ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'];
const PROCESS_VALUES = ['ウォッシュド', 'ナチュラル', 'ハニー', 'その他'];

async function identifyBean(base64Data, mediaType) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `あなたはコーヒー豆の記録アプリ「Bean Diary」の自動入力アシスタントです。
写真(パッケージ・ラベル)から読み取れる情報のみを根拠に、identify_beanツールで豆の基本情報を1件推定してください。
推測で埋めるのではなく、写真から読み取れない項目は省略してください(フォーム側は空欄のままになります)。
confidenceは、写真から豆・店名がはっきり特定できた場合は"high"、一部の情報のみ読み取れた場合は"medium"、
ラベルがほとんど読めない・推測に近い場合は"low"としてください。`,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: 'このコーヒー豆のパッケージ写真から情報を推定してください。' },
        ],
      },
    ],
    tools: [
      {
        name: 'identify_bean',
        description: '写真に写っているコーヒー豆のパッケージ・ラベルから基本情報を推定する',
        input_schema: {
          type: 'object',
          required: ['confidence'],
          properties: {
            name: { type: 'string', description: '豆の名前' },
            shop: { type: 'string', description: '購入先・店名' },
            origin: { type: 'string', description: '産地' },
            roast: { type: 'string', enum: ROAST_VALUES },
            process: { type: 'string', enum: PROCESS_VALUES },
            taste: {
              type: 'object',
              description: '読み取れた場合のみ、各1〜5の整数で推定する',
              properties: {
                酸味: { type: 'integer', minimum: 1, maximum: 5 },
                苦味: { type: 'integer', minimum: 1, maximum: 5 },
                甘味: { type: 'integer', minimum: 1, maximum: 5 },
                コク: { type: 'integer', minimum: 1, maximum: 5 },
                香り: { type: 'integer', minimum: 1, maximum: 5 },
              },
            },
            flavor_notes: { type: 'string', description: '公式の風味説明(分かる場合のみ)' },
            source_url: { type: 'string', description: '参照した公式ページのURL(分かる場合のみ)' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'identify_bean' },
  });

  const toolUse = res.content?.find((b) => b.type === 'tool_use' && b.name === 'identify_bean');
  if (!toolUse) throw new Error('identify_bean tool not called');
  return toolUse.input;
}

app.post('/api/identify', identifyLimiter, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'image is required' });
    }
    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'invalid image data URL' });
    }
    const [, mediaType, base64Data] = match;
    const sizeBytes = Buffer.byteLength(base64Data, 'base64');
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'image too large (max 8MB)' });
    }

    const result = await identifyBean(base64Data, mediaType);
    res.json(result);
  } catch (err) {
    console.error('[identify] error', err);
    res.status(500).json({ error: 'failed to identify bean' });
  }
});

app.get('/api/version', (req, res) => {
  const { version } = require('./package.json');
  res.json({ version });
});

app.listen(PORT, () => {
  console.log(`Bean Diary server listening on port ${PORT}`);
});
