# Bean Diary (coffee.willoa.net) - CLAUDE.md

本ファイルは毎ターン自動で読み込まれるため、**現在の仕様と守るべきルールだけ**を書く。調査の経緯・比較検討の詳細は本リポジトリ作成時のチャット履歴を参照(現時点では`CLAUDE_HISTORY.md`は未作成)。

## プロジェクト概要
コーヒー豆を写真で記録し、豆ごとに「日々のひとことメモ」を積み上げていく個人用の記録帳(PWA+iOS)。ブランド: Willoa(SG在住Navi・SGBusNaviの姉妹アプリ)。アプリ名: **Bean Diary**。UI言語: 日本語固定(i18n機構は導入しない)。軸は日付ではなく豆(「日記」ではなく「豆とともに日常を残す」)。詳細な機能要件は引き継ぎ資料のSPEC.mdを参照。

## 前例・踏襲するプロジェクト
`/home/masahiko/sg-bus-navi/`(SGBusNavi、`bus.willoa.net`)が直近の「Willoa姉妹アプリを独立構築する」前例。技術スタック・デプロイ方式・iOS/TestFlightパイプラインはこちらを踏襲する。**デザイン(配色・フォント)のみ踏襲しない**(後述)。

## アプリの位置づけ(SG在住Navi/SGBusNaviとの関係)
- 完全に独立したプロジェクト・ドメイン・サーバープロセス。既存アプリのボトムナビ・画面・データには一切統合しない。
- アカウント・ログイン機能は無い。個人データ(豆・日々のメモ・写真)はサーバーに一切保存せず、**端末内IndexedDBのみ**に保存する。サーバー側に`data/`相当の個人データファイルは作らない。

## サーバー・運用(予定、構築時に確定させる)
- VPS: Contabo(194.233.82.43)、ユーザー`masahiko`、パス`/home/masahiko/mamelog/`(sg-weekend-app・sg-bus-naviと同じVPS)
- ドメイン: `coffee.willoa.net`(willoa.netのサブドメイン)
- ポート: `.env`の`PORT`、**3011**(2026-11-22時点でVPS上のPM2確認済み: 3000=sg-weekend/dosuru.app、3001=willoa本体、3010=sg-bus-navi。3011は未使用)
- PM2プロセス名: `mamelog`(フォルダ名に合わせる。アプリ表示名Bean Diaryとは独立)
- スタック: Node.js/Express、Vanilla JS、PWA。**DBなし**。サーバー側に恒常的なユーザーデータJSONは持たない想定(将来共有コンテンツが必要になれば`data/`を追加)
- nginx設定は本リポジトリ内に`nginx-coffee.willoa.net.conf`として下書きを保管し、DNS伝播後に`/etc/nginx/sites-available/`へコピー→`certbot --nginx`→`nginx -t`→reloadの手順を取る(sg-bus-naviと同じ安全フロー)。**このユーザーにはnginx/certbot/systemctlへのpasswordless sudoが無い**(willoa-site CLAUDE.mdに記録済みの既知事項)ため、該当コマンドはユーザー自身のターミナルで実行してもらう
- DNS: Cloudflareで`coffee`のCNAME/Aレコードを`willoa.net`ゾーンに追加(DNS onlyモード、既存の`bus`と同じ)

## 画面構成
ボトムナビ4タブ(2026-11-24「好み」タブ追加により4タブ構成が確定。設計書1`.claude/plan.md`参照): **豆**(一覧)/ **日々**(月カレンダー+選択日の年またぎ比較、後述)/ **豆知識**(コーヒーの基本をカテゴリ別に確認)/ **好み**(記録サマリー+AI傾向分析・おすすめ、★アイコン)。豆を追加する操作はボトムナビではなく、豆/日々/豆知識タブ共通のメインFAB(＋ボタン)経由の小メニュー(「豆を追加」「ひとことを追加」)から行う。設定はボトムナビに含めず、各画面右上の歯車アイコンから別画面へ遷移する。ユーザーより「好みタブがボトムメニューの最後の機能」と明言済み(今後5つ目のタブ追加は想定しない)。

## データモデル(端末内IndexedDB、DB名`beandiary`案)
- `beans`ストア: id/photo/name/shop/origin/roast/process/purchaseDate/taste{酸味,苦味,甘味,コク,香り}/rating/brew/flavorNotes/sourceUrl/createdAt(SPEC §2.1)
- `entries`ストア: id/beanId(インデックス)/text/photo/createdAt(SPEC §2.1b)。text/photoはどちらか必須
- 写真は保存前に長辺900px・JPEG品質0.8にクライアント側(Canvas)で縮小してから格納
- バックアップ書き出し/復元(JSON、写真のBase64埋め込み)・全データ削除は設定画面から(SPEC §2.2-5)

## AI自動入力(写真から豆情報を推定)
- エンドポイント: `POST /api/identify`、リクエスト`{ image: "data:image/jpeg;base64,..." }`(上限約8MB、`express.json({limit:'12mb'})`で個別対応)
- モデル: **`claude-sonnet-4-6`**(SG在住Naviの既存画像解析=`generateEventDraft()`と同じ実績ある構成。SPEC.md記載の`claude-opus-5-5`はプロジェクト内に実例が無い未来日付的な仮称のため採用しない)
- Web検索ツール`web_search_20260209`(name: `web_search`、`claude-sonnet-4-6`が対応モデルに含まれることを確認済み)を併用し、`flavor_notes`・`source_url`等の補足情報を調べる(`max_uses: 3`で回数を制限)。`tool_choice`は強制しない(強制すると`web_search`が使えなくなるため)。システムプロンプトで「調査が終わったら必ず`identify_bean`を呼ぶ」よう指示し、応答から`identify_bean`のtool_useブロックを探す。サーバー側ツールの内部反復が10回を超えると`stop_reason:'pause_turn'`で一旦返るため、会話をそのまま再送して継続する(SPEC §4通り最大5回)。`refusal`はエラー扱い
- 構造化出力は`tools`+`tool_choice`(SG在住Naviの`create_event`パターンと同じ)で取得し、プロトタイプのような正規表現抜き出しは使わない
- レスポンスは空欄のみフォームに反映(ユーザーが既に入力した項目は上書きしない)。保存前に必ずユーザーが確認する
- APIキー(`ANTHROPIC_API_KEY`)はサーバー環境変数のみ。クライアントに置かない
- 設定の「写真からの自動入力」トグルは**初期状態でON**(説明文「豆を判別するため、写真を外部のAIサービスに送信します」を必ず表示)。OFF時は写真を送信しない
- レート制限: `/api/identify`専用に厳しめのリミッター(`express-rate-limit`、例: 1分あたり10回程度)を適用する。SGBusNaviの2段構成レート制限を参考にする

## AI好み分析(「好み」タブ、2026-11-24追加、2026-11-28に実在商品の提案に変更)
- エンドポイント: `POST /api/recommend`、リクエスト`{ entries: [{ origin, roast, process, brew, rating }, ...] }`(画像は含めない、最大50件)
- モデル: `claude-sonnet-4-6`(`/api/identify`と統一)。**2026-11-28〜web_searchを使用する**(ユーザーから「傾向だけでなく具体的な豆を紹介してほしい」との要望。以前はハルシネーション対策で特徴の組み合わせのみを提案していたが、`identifyBean()`と同じ「検索結果に基づいてのみ報告する」方針に統一)。`tool_choice`は強制しない(強制するとweb_searchが使えなくなるため)。`identifyBean()`と同じ`pause_turn`再送ループが必要
- レスポンス: `{ summary, recommendations: [{name, shop, origin, roast, process, source_url, reason}] }` を3件固定。`name`(実在商品名)・`shop`(販売元)は必須、`origin`/`roast`/`process`は検索で分かった場合のみ。検索で見つけた実在商品のみを報告し、記憶から商品名を作り出さないようシステムプロンプトで明記
- 対象データ: `entries`のうち`rating > 0`(★評価済み)のみ。各エントリの自由記述`text`・写真・豆名・店名は送らない(送信データ最小化のプライバシー方針)。★評価付きの記録が5件未満の場合はタブ内で空状態を表示し、AI呼び出しは行わない
- 送信は「分析する/再分析する/更新する」ボタンをユーザーが明示的に押したときのみ(自動実行しない)。専用の同意トグルは設定画面に追加しない(ボタン自体が同意ジェスチャーになるため)
- 分析結果はサーバーに保存しない(ステートレスなリレーのみ)。端末側では`settings.preferenceAnalysis`(localStorage、新規IndexedDBストアは作らない)に`{summary, recommendations, analyzedAt, basedOnCount}`として保存し、次回タブを開いたときに前回結果を表示する
- レート制限: `recommendLimiter`(1分あたり5回、`/api/identify`より厳しい)

## AI豆インサイト(豆カード展開時、2026-11-28追加)
- エンドポイント: `POST /api/bean-insight`、リクエスト`{ entries: [{ text, rating, brew }, ...] }`(その豆1件分の記録のみ、画像・豆名・店名は含めない、最大50件)
- モデル: `claude-sonnet-4-6`。web_searchは使わない。`tools`+`tool_choice: {type:'tool', name:'bean_insight'}`で構造化出力を強制
- レスポンス: `{ comment }` のみ(60字程度の一言)。`/api/recommend`と違い複数豆の比較はしない、この豆単体の記録からの印象のみ
- 対象データ: その豆に紐づく`entries`全件(★評価の有無は問わない)。最低3件から有効(好みタブの5件より緩め、1豆あたりの記録数は少なくなりがちなため)
- 表示位置: 豆カード展開時、レーダーチャート/基本情報の下・「この豆にひとことを追加」ボタンの上
- 送信は「AIにこの豆の傾向を聞く/再分析する」ボタンを明示的に押したときのみ(自動実行しない)
- 分析結果はサーバーに保存しない。端末側では`bean.aiInsight`として`{comment, analyzedAt, basedOnCount}`をbeansストアに保存(新規ストアは作らない)。記録件数が`basedOnCount`と変わったら「新しい記録があります」と表示する
- レート制限: `beanInsightLimiter`(1分あたり5回、`recommendLimiter`と同じ)

## カメラ
`@capacitor/camera`を新規導入する(ネイティブ`<input capture>`方式は不採用。Capacitor WKWebView上での動作安定性とカメラ/ライブラリの明示選択UIのため)。iOS `Info.plist`に`NSCameraUsageDescription`・`NSPhotoLibraryUsageDescription`の追加が必須(CIワークフローにPlistBuddyステップを追加、SGBusNaviが位置情報キーを追加した時と同型の変更)。

## デザイン(SG在住Navi/SGBusNaviの柳グリーンは踏襲しない)
SPEC.md本来のクリーム/エスプレッソ/キャラメル配色・Zen Maru Gothicフォントを採用し、Bean Diary独自の世界観を優先する。ただし以下の**操作性の基本条件**は既存アプリ(sg-weekend-app実測)と揃える:
- 最小フォントサイズ: **11px以上**(これ未満は使わない)
- `<input>`の`font-size`は**16px以上**必須(iOS Safariの自動ズーム防止)
- 閉じる✕ボタン: 32×32px・円形
- タップ対象は最低44×44px相当を確保
- カード角丸・ボタン角丸等の具体値はBean Diary独自でよいが、CSS変数で一元管理し生のhex値をインラインに書かない(既存2アプリ共通のCSS規約を踏襲)
- ダークモード対応(自動/ライト/ダーク)。`html[data-theme]`方式で切り替える

CSS変数の二層構造(ベース変数→意味的エイリアス、SGBusNaviのパターン)を採用する。詳細なトークン値は実装時に`public/css/style.css`の`:root`で確定する。

## iOS/TestFlight
`sg-bus-navi/ios-app/`と同型構成(Capacitor+Fastlane)を踏襲する。
- `appId`: **`net.willoa.coffee`**(SGBusNaviの`net.willoa.bus`の命名規則に合わせる)
- `webDir: '../public'`のローカルバンドル方式
- 証明書: `fastlane match`不使用。OpenSSL(`-legacy`必須)で`.p12`+プロビジョニングプロファイルを自前生成し、GitHub Secretsにbase64で登録(`sg-bus-navi/ios-app/README.md`の手順をそのまま流用)
- CI: `release`ブランチpush→GitHub Actions(macOS)→`cap add ios`→アイコン/スプラッシュ生成→`cap sync ios`→iOS最低バージョン15.0パッチ→`pod install`→Info.plist設定(カメラ権限含む)→Fastlane→TestFlight(社内のみ、Apple審査不要)
- 新規にApple Developer上でApp ID登録・TestFlight内部テスターグループ設定が必要(ユーザー側の作業)
- GitHubリポジトリは`oguworld/<repo名>`形式でpublic想定(sg-bus-naviと同じ)

## 日々タブ(月カレンダー+年またぎ比較、2026-11-28変更)
- 旧仕様の時系列フィード(今日/昨日/日付ごとのグルーピング)から、月カレンダー表示に変更。「3年日記」「5年日記」(同じ月日を複数年並べて振り返る紙の日記フォーマット)のデジタル版として設計
- カレンダーは月単位でナビゲーション(前月/次月ボタン)。記録がある日はセルに小さいドットを表示(`entriesCache`全体から構築した日付キーのSetで判定)
- 日付セルをタップすると、その月日について**記録が存在する最古の年まで遡って**年ごとの比較パネルを表示(「今年」→「1年前」→「2年前」...)。年数を固定上限にしない(使い続けた年数だけ自然に行が増える設計、ユーザー要望通り3年/5年どちらにも自動対応)。該当年にその日の記録が無い場合は「この日の記録はありません」を薄く表示
- 今日の日付はカレンダー上でキャラメル色のセルとして強調。選択中の日付(今日以外)は`--caramel-pale`で区別
- 「今日のひとことで選べる豆」のクイック入力(FAB経由)は従来通り独立した仕組みで、この変更の影響を受けない

## i18n
日本語UI固定。SG在住Naviの`data-i18n`+`STRINGS.ja`機構は導入しない(SGBusNaviが英語固定でi18n機構を導入していない前例と同じ判断。過剰な抽象化を避ける)。文字列は直接HTML/JSに日本語で書く。

## スコープ外(初版で作らないもの)
味のレーダーチャート(豆単体の味評価は別途実装済み。「傾向」としての統計画面は「好み」タブの記録サマリー+AI分析で限定的に対応済み、2026-11-24)・並び替え/フィルタ拡張・JSONエクスポート単体機能・SG店舗情報との連携・日々のメモへの味タグ付け・「今日の一杯」リマインド・クラウド同期・アカウント機能・通知/リマインド設定・本番App Store審査提出(今回のゴールはTestFlightまで)。

## 開発フロー
このリポジトリも`sg-weekend-app`と同じ規約に従う: 新機能・複数ファイルに跨る修正はplanner→orchestrator(builder→checker→closer)の順。設計の経緯は`.claude/plan.md`に末尾追記(「設計書N」の連番、このリポジトリ専用に1から開始)。
