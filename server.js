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

// /api/recommendは「まとめて振り返る」意図的な操作で連打の正当な理由が薄いため、
// /api/identify(1分10回)よりやや厳しくする(設計書1参照)。
const recommendLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // SPEC §4: 画像サイズ上限 約8MB
const MAX_RECOMMEND_ENTRIES = 50; // /api/recommend に送るエントリ件数の上限

const ROAST_VALUES = ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'];
const PROCESS_VALUES = ['ウォッシュド', 'ナチュラル', 'ハニー', 'その他'];

const IDENTIFY_BEAN_TOOL = {
  name: 'identify_bean',
  description: '写真と(必要な場合の)Web検索結果から、コーヒー豆の基本情報を1件報告する。調査が終わったら必ず最後にこのツールを呼ぶこと。',
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
};

const RECOMMEND_TOOL = {
  name: 'recommend_beans',
  description: 'ユーザーの★評価付きの記録傾向から、次に試すとよさそうな豆の「特徴の組み合わせ」を3件まとめて報告する。実在の商品名・ロースター名は絶対に出さないこと。',
  input_schema: {
    type: 'object',
    required: ['summary', 'recommendations'],
    properties: {
      summary: { type: 'string', description: 'これまでの記録から読み取れる好みの傾向を要約する一言(1〜2文)' },
      recommendations: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          required: ['title', 'origin', 'roast', 'process', 'reason'],
          properties: {
            title: { type: 'string', description: '特徴の組み合わせを表す短い見出し(例: 「エチオピア産 × 浅煎り × ウォッシュド」)' },
            origin: { type: 'string', description: '産地' },
            roast: { type: 'string', enum: ROAST_VALUES },
            process: { type: 'string', enum: PROCESS_VALUES },
            reason: { type: 'string', description: 'この組み合わせを勧める理由と期待される風味の一言' },
          },
        },
      },
    },
  },
};

// web_searchは使わない(実在商品を検索・提案させないための方針、設計書1参照)。
// そのためpause_turnループは不要で、単発のmessages.create()のみで完結する。
async function recommendBeans(entries) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: JSON.stringify(entries) }],
    },
  ];

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `あなたはコーヒー豆の記録アプリ「Bean Diary」の好み分析アシスタントです。
ユーザーの★評価付きの記録(各要素は origin[産地]・roast[焙煎度]・process[精製方法]・brew[淹れ方]・rating[1〜5の評価]のJSON配列)を受け取り、
評価の傾向から好みを分析してください。
重要な制約: 実在の商品名・ブランド名・ロースター名・店名は絶対に出さないこと。あなたはWeb検索ができないため、
実在商品を挙げることは不正確な情報(ハルシネーション)になります。必ず「産地×焙煎度×精製方法」のような
特徴の組み合わせとして提案してください。
必ず recommend_beans ツールを1回呼んで結果を報告してください。`,
    messages,
    tools: [RECOMMEND_TOOL],
    tool_choice: { type: 'tool', name: 'recommend_beans' },
  });

  if (res.stop_reason === 'refusal') throw new Error('request refused');

  const toolUse = res.content?.find((b) => b.type === 'tool_use' && b.name === 'recommend_beans');
  if (!toolUse) throw new Error('recommend_beans tool not called');
  return toolUse.input;
}

// サーバー側ツール(web_search)はAPI内部で最大10回まで自動反復し、それを超えると
// stop_reason:'pause_turn'で一旦返ってくる。SPEC §4通り、その場合は会話をそのまま
// 再送して継続する(最大5回まで)。tool_choiceは強制しない(強制するとweb_searchが
// 使えなくなるため、システムプロンプト側で「最後に必ずidentify_beanを呼ぶ」よう指示する)。
async function identifyBean(base64Data, mediaType) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: 'このコーヒー豆のパッケージ写真から情報を推定してください。' },
      ],
    },
  ];

  const requestParams = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1536,
    system: `あなたはコーヒー豆の記録アプリ「Bean Diary」の自動入力アシスタントです。
写真(パッケージ・ラベル)から豆の名前・店名・産地等を読み取り、必要なら web_search で公式サイト・販売ページを
数回(2〜3回程度で十分、多くても)調べて、風味説明(flavor_notes)や参照URL(source_url)等の補足情報を集めてください。
調査が終わったら、推測で埋めるのではなく確認できた情報だけを使い、必ず identify_bean ツールを1回呼んで結果を報告してください
(写真やWeb検索だけで終わらせず、最後に必ずこのツールを呼ぶこと)。読み取れない・確認できない項目は省略してください
(フォーム側は空欄のままになります)。confidenceは、豆・店名がはっきり特定できた場合は"high"、一部の情報のみ読み取れた場合は"medium"、
ラベルがほとんど読めない・推測に近い場合は"low"としてください。`,
    messages,
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
      IDENTIFY_BEAN_TOOL,
    ],
  };

  let res = await client.messages.create(requestParams);

  for (let resumeCount = 0; res.stop_reason === 'pause_turn' && resumeCount < 5; resumeCount++) {
    messages.push({ role: 'assistant', content: res.content });
    res = await client.messages.create({ ...requestParams, messages });
  }

  if (res.stop_reason === 'refusal') throw new Error('request refused');

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

app.post('/api/recommend', recommendLimiter, async (req, res) => {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries must be a non-empty array' });
    }
    if (entries.length > MAX_RECOMMEND_ENTRIES) {
      return res.status(400).json({ error: `entries must be at most ${MAX_RECOMMEND_ENTRIES} items` });
    }

    const result = await recommendBeans(entries);
    res.json(result);
  } catch (err) {
    console.error('[recommend] error', err);
    res.status(500).json({ error: 'failed to analyze preferences' });
  }
});

app.get('/api/version', (req, res) => {
  const { version } = require('./package.json');
  res.json({ version });
});

app.listen(PORT, () => {
  console.log(`Bean Diary server listening on port ${PORT}`);
});
