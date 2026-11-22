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
ボトムナビ3タブ(SPEC.md §2.2通り): **豆**(一覧)/ **＋**(中央の大きい丸ボタン、豆追加)/ **日々**(全豆のEntryを日付順)。設定はボトムナビに含めず、豆・日々画面右上の歯車アイコンから別画面へ遷移する。

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

## i18n
日本語UI固定。SG在住Naviの`data-i18n`+`STRINGS.ja`機構は導入しない(SGBusNaviが英語固定でi18n機構を導入していない前例と同じ判断。過剰な抽象化を避ける)。文字列は直接HTML/JSに日本語で書く。

## スコープ外(初版で作らないもの)
傾向(統計)画面・味のレーダーチャート・並び替え/フィルタ拡張・JSONエクスポート単体機能・SG店舗情報との連携・日々のメモへの味タグ付け・「今日の一杯」リマインド・クラウド同期・アカウント機能・通知/リマインド設定・本番App Store審査提出(今回のゴールはTestFlightまで)。

## 開発フロー
このリポジトリも`sg-weekend-app`と同じ規約に従う: 新機能・複数ファイルに跨る修正はplanner→orchestrator(builder→checker→closer)の順。設計の経緯は`.claude/plan.md`に末尾追記(「設計書N」の連番、このリポジトリ専用に1から開始)。
