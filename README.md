# かかりつけ

かかりつけの病院・歯科・薬局などの診療時間を、必要なときにすぐ確認できる Web アプリです。

- Google アカウントでログインし、データは Firebase (Firestore) に保存
- 公式サイトの URL・画像・文章から Gemini API で診療時間を自動入力
- GitHub Pages で公開（push するたびに自動デプロイ）
- 画面右下に `ver1.0.0 2026-10-08 18:30`（バージョン＋デプロイ日時 JST）を表示

## 構成

ビルド不要の静的サイトです。

| ファイル | 内容 |
| --- | --- |
| `index.html` / `css/style.css` | 画面 |
| `js/app.js` | 画面遷移・Firebase 連携 |
| `js/gemini.js` | Gemini API による診療時間の読み取り |
| `js/icons.js` | SVG アイコン |
| `js/firebase-config.js` | Firebase の設定値（要記入） |
| `js/version.js` | バージョン（修正のたびに上げる） |
| `firestore.rules` | Firestore のセキュリティルール |
| `.github/workflows/deploy.yml` | GitHub Pages への自動デプロイ |

## セットアップ

### 1. Firebase

1. <https://console.firebase.google.com/> で「プロジェクトを追加」（Google アナリティクスは不要）
2. **Authentication** → 「始める」→ ログイン方法で **Google** を有効化
3. **Authentication** → 設定 → **承認済みドメイン** に `kyosuke0306.github.io` を追加
4. **Firestore Database** → 「データベースを作成」（ロケーションは `asia-northeast1` 推奨、本番環境モード）
5. Firestore → **ルール** に `firestore.rules` の内容を貼り付けて「公開」
6. プロジェクトの設定（歯車）→ マイアプリ → `</>`（ウェブ）でアプリを登録し、表示された `firebaseConfig` の値を `js/firebase-config.js` に貼り付け

Firebase の無料プラン（Spark）で十分に動きます。

### 2. GitHub Pages

1. リポジトリの **Settings → Pages**
2. Source を **Deploy from a branch**、Branch を **`gh-pages` / `(root)`** にして保存
   （`gh-pages` ブランチは最初の push 後に GitHub Actions が自動作成します）
3. 公開 URL: `https://kyosuke0306.github.io/kakarituke/`

`main` または作業ブランチに push するたびに自動で公開されます。Actions タブで進捗を確認できます。

### 3. Gemini API キー

1. <https://aistudio.google.com/apikey> で API キーを作成（無料枠あり）
2. アプリにログイン → 右上の設定 → 「Gemini API」にキーを貼り付けて保存

キーはログインユーザー本人だけが読める Firestore の領域に保存され、ソースコードには含まれません。
モデル名は既定で `gemini-2.5-flash`。提供終了などで使えなくなった場合は設定画面で変更できます。

## 使い方

1. ホームで「病院」→「内科」などを選ぶ
2. 右上の `+` で登録。公式サイトの URL を入れて「URLから読み取る」を押すと診療時間が入力されます
   - サイトが読めない場合は「画像から」（看板や診察券の写真）または「文章から」（サイトの文章を貼り付け）
3. 内容を確認して保存
4. 詳細画面では今日の曜日が強調表示され、「診療中」「本日休診」などが分かります
5. 臨時休診は「公式サイト」ボタンから確認できます

## 開発メモ

- 修正時は `js/version.js` の `VERSION` を上げる（例: バグ修正 1.0.0 → 1.0.1、機能追加 → 1.1.0）
- ローカル確認: `python3 -m http.server` で起動（右下は `local` と表示）
