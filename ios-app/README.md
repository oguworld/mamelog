# Bean Diary iOS アプリ — セットアップ手順

## 概要

このディレクトリにはCapacitorを使ったiOSアプリのビルド設定が入っています。
姉妹アプリSGBusNavi(sg-bus-navi)・SG在住Navi(sg-weekend-app)と同じ方式で、
`release`ブランチへのpushだけでGitHub Actions(macOSランナー)がビルドし
TestFlightに自動アップロードします。Bean Diaryはログイン・プッシュ通知・
Google/Apple認証を使わないため、sg-weekend-app側にあるそれらの複雑な設定
(APNs bridge・Google Sign-Inスキーム注入・プライバシーマニフェスト等)は不要です。
ただしBean Diaryは写真から豆情報を自動入力するため**カメラ機能(`@capacitor/camera`)
を使う**点がSGBusNaviと異なり、`Info.plist`へのカメラ・フォトライブラリ利用目的の
登録がCIワークフローに追加されています。

証明書・プロビジョニングプロファイルは`fastlane match`は使わず、手動で作成した
ものをBase64エンコードしてGitHub Secretsに登録する方式です(`sg-bus-navi`で
実績のある方式をそのまま踏襲)。

---

## 初回セットアップ(Macなしで完結する方法・sg-bus-naviで実績あり)

### 前提条件

- Apple Developer Programに登録済みであること($99/年)
- App IDを登録済みであること: `net.willoa.coffee`(Certificates, Identifiers & Profiles → Identifiers)
  - **カメラ機能を使うため、App ID登録時にCapability「—」特になし(カメラはCapabilityではなくInfo.plistの利用目的キーのみで良い)**
- App Store ConnectでApp本体を作成済みであること(名前: Bean Diary)

### 1. CSR(証明書署名要求)をOpenSSLで作成 — Mac不要

```bash
openssl genrsa -out ios_distribution.key 2048
openssl req -new -key ios_distribution.key -out ios_distribution.csr \
  -subj "/emailAddress=oguworld@gmail.com/CN=WILLOA PTE. LTD./C=SG"
```

**`ios_distribution.key`(秘密鍵)は証明書が実際に発行され、TestFlightアップロードが
成功するまで絶対に削除しないこと。**

### 2. Distribution証明書の作成(ブラウザのみ)

Apple Developer portal → Certificates → 「+」→ **Apple Distribution** を選択し、
手順1の`ios_distribution.csr`をアップロードして作成、`.cer`をダウンロードします。
(姉妹アプリと共用の証明書を使い回せる場合は新規作成不要。別の証明書を使う場合のみ新規作成)

### 3. `.p12`へのバンドル — `-legacy`フラグが必須

```bash
openssl x509 -inform DER -in distribution.cer -out distribution.pem -outform PEM
openssl pkcs12 -export -legacy \
  -inkey ios_distribution.key \
  -in distribution.pem \
  -out distribution.p12 \
  -passout pass:<任意のパスワード、これが DIST_CERT_PASSWORD>
```

`-legacy`を付け忘れると`SecKeychainItemImport`エラーでCIが失敗します(OpenSSL 3.x系の
デフォルト暗号化がmacOS Keychainと非互換のため)。

### 4. App Store用プロビジョニングプロファイルの作成(ブラウザのみ)

Apple Developer portal → Profiles → 「+」→ **App Store Connect** を選択し、
App ID `net.willoa.coffee`・手順2の証明書を指定して作成します。
プロファイル名は **`beandiary_appstore`** にしてください(`Fastfile`にハードコード済み)。
`.mobileprovision`をダウンロードします。

### 5. 証明書・プロファイルをBase64化

```bash
base64 -w0 distribution.p12 > dist_cert_base64.txt                    # DIST_CERT_BASE64
base64 -w0 beandiary_appstore.mobileprovision > provision_base64.txt  # PROVISION_PROFILE_BASE64
```

### 6. App Store Connect APIキーの作成

App Store Connect → ユーザとアクセス → 統合 → App Store Connect API →「+」で新規キーを作成し、
`.p8`ファイルをダウンロード(1回のみ)。Key ID・Issuer IDも控えておきます。
(姉妹アプリと同じApp Store Connectチームで作業する場合、既存キーを使い回せる)

### 7. GitHub Secretsに登録

```bash
gh secret set ASC_KEY_ID --repo oguworld/mamelog --body "<Key ID>"
gh secret set ASC_ISSUER_ID --repo oguworld/mamelog --body "<Issuer ID>"
gh secret set ASC_PRIVATE_KEY --repo oguworld/mamelog < AuthKey_XXXXXXXXXX.p8
gh secret set DIST_CERT_BASE64 --repo oguworld/mamelog < dist_cert_base64.txt
gh secret set DIST_CERT_PASSWORD --repo oguworld/mamelog --body "<手順3で設定したパスワード>"
gh secret set PROVISION_PROFILE_BASE64 --repo oguworld/mamelog < provision_base64.txt
gh secret set APPLE_TEAM_ID --repo oguworld/mamelog --body "<Team ID>"
```

または、リポジトリの Settings → Secrets and variables → Actions からブラウザで登録:

| Secret名 | 内容 |
|---|---|
| `ASC_KEY_ID` | App Store Connect APIキーのID |
| `ASC_ISSUER_ID` | App Store Connect APIキーの発行者ID |
| `ASC_PRIVATE_KEY` | `.p8`ファイルの中身(改行含む文字列そのまま) |
| `DIST_CERT_BASE64` | 手順5でBase64化した`.p12`の中身 |
| `DIST_CERT_PASSWORD` | `.p12`エクスポート時に設定したパスワード |
| `PROVISION_PROFILE_BASE64` | 手順5でBase64化した`.mobileprovision`の中身 |
| `APPLE_TEAM_ID` | Apple DeveloperのTeam ID |

---

## 日常的なリリース手順

```bash
git checkout release
git merge main
git push origin release
```

pushすると自動で以下が実行されます: Capacitorのios追加→アイコン/スプラッシュ生成→
カメラ権限キーの登録→最低iOSバージョン15.0への引き上げ(ITMS-90068対応)→ビルド→
TestFlightへアップロード(内部テストのみ、`distribute_external: false`)。

---

## アイコン・スプラッシュ画像について

| ファイル | サイズ | 備考 |
|---|---|---|
| `resources/icon.png` | 1024×1024px | プレースホルダー(クリーム/エスプレッソ配色+豆アイコン)。アルファチャンネルなし |
| `resources/splash.png` | 2732×2732px | 背景`#F6F0E8`(--cream)+中央にアイコン+ロゴ |
| `resources/splash-dark.png` | 2732×2732px | 背景`#211611`(ダークモードの--cream)+中央にアイコン+ロゴ |

いずれもプレースホルダーです。正式なアプリアイコンが決まったら差し替えてください。

---

## トラブルシューティング

### `SecKeychainItemImport: One or more parameters passed to a function were not valid`

`.p12`エクスポート時に`-legacy`フラグを付け忘れているのが原因です。手順3を参照し、
`-legacy`付きで`.p12`を作り直し、Base64化→`DIST_CERT_BASE64`を更新してください。

### バージョン番号について

`ios-app/package.json`の`version`がマーケティングバージョンとしてFastfileから読み込まれます。
ビルド番号(`CFBundleVersion`)は`github.run_number`から自動採番されるため、同じ`version`の
ままpushを繰り返してもビルド番号は毎回自動で増えます。
