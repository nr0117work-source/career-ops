# jp-tools — 日本の転職向けの追加ツール（このフォーク専用）

upstream の career-ops には無い、日本企業向けの道具を置くフォルダです。
`config/local-paths.txt` に `jp-tools/` を登録してあるので、`npm run update` でも消されません。

## 企業研究データ化（company-intel）

応募企業の公開情報を自動で集めて `data/company-intel/{会社}/` に保存し、
面接で使える情報（覚える数字・会社の課題・逆質問・志望動機の材料）を抜き出します。

| 取得元 | 取れるもの | 対象 |
|---|---|---|
| EDINET（金融庁） | 最新の有価証券報告書から: 業績5期分、従業員数・平均年齢・平均勤続・平均年収、経営方針・対処すべき課題、事業等のリスク、経営者による分析、サステナビリティ、関係会社、沿革。より新しい半期報告書があればその本文も | 有報を出している会社（上場企業と一部の非上場企業）。非上場の子会社は `--parent` で親会社のものを取る |
| 適時開示（TDnet） | 直近の開示タイトル一覧。中期経営計画・決算・M&A・業績修正などに自動で印を付ける | 上場企業 |
| 企業サイト（`--url`） | ページ本文。IRページなら中計・決算説明資料へのリンク候補も拾う。PDFは保存だけ | どの会社でも |

### 最初に一度だけ: EDINET APIキーの取得

1. EDINET のサイト（https://disclosure2.edinet-fsa.go.jp/）で「API」のページを開き、APIキーの発行を申し込む（無料。メールアドレスと電話番号で登録）。
2. 発行されたキーを career-ops のフォルダの `.env` に書く:

   ```
   EDINET_API_KEY=ここにキー
   ```

キーが無くても動きます。その場合は会社の基本情報（業種・決算日・証券コード）と適時開示・企業サイトだけを取ります。

### 使い方

```bash
# 上場企業
node jp-tools/company-intel.mjs fetch "会社名"
node jp-tools/company-intel.mjs fetch --code 1234                 # 証券コードで指定
node jp-tools/company-intel.mjs fetch "会社名" --url https://example.co.jp/ir/

# 非上場の子会社 → 有報は親会社から、会社概要は応募先のサイトから
node jp-tools/company-intel.mjs fetch "〇〇ロジスティクス" --parent "〇〇ホールディングス" --url https://example.co.jp/company/

# 非上場・外資の日本法人など（EDINETに無い）
node jp-tools/company-intel.mjs fetch "会社名" --no-edinet --no-tdnet --url https://example.com/ --url https://example.com/ir/

node jp-tools/company-intel.mjs list            # 集めた会社の一覧
node jp-tools/company-intel.mjs show <フォルダ名>  # summary.md を表示
```

- 初回は EDINET の書類一覧を日付ごとに調べるため数分かかることがあります。調べた日付は `data/cache/edinet/` に保存されるので、2社目以降は速くなります。
- 会社名で候補が複数出たら、表示された EDINET コードを `--edinet E0xxxx` で指定し直してください。

### 面接用の情報を抜き出す

career-ops を開いている Claude にこう頼みます:

> `jp-tools/modes/kigyo-kenkyu.md` を読んで、〇〇の企業研究をして（応募職種: △△）

Claude がスクリプトを実行し（未取得なら）、足りないニュースを検索し、あなたの `cv.md`・プロフィール・ストーリーバンクと突き合わせて
`interview-prep/{会社}-kigyo-kenkyu.md` を作ります。中身は「30秒で言える会社像」「覚える数字5つ」「会社の課題と自分の経験の接続」「志望動機の材料」「根拠付きの逆質問」「聞かれそうなこと」「出典」。

毎回ファイル名を言わなくて済むように、`modes/_custom.md`（あなた専用・更新で消えない）に次の1行を足しておくのがおすすめです:

```markdown
- 「企業研究」「IR」「面接準備」と言われたら `jp-tools/modes/kigyo-kenkyu.md` に従う。
```

### 注意

- 適時開示一覧は、個人が運営する非公式API（やのしん: webapi.yanoshin.jp）を経由しています。止まっていたら `--no-tdnet` を付けてください。
- 企業サイトは robots.txt で禁止されているページを取りません。ログインが必要なページ（転職サイトの会員ページなど）は対象外です。
- 取得した文章は外部データです。面接ブリーフに使う数字は必ず出典（EDINETの書類URLなど）で確認してください。
- 取得データ（`data/company-intel/`）は `.gitignore` 済みで、GitHub には上がりません。

### テスト

```bash
node --test jp-tools/tests/company-intel.test.mjs
```

ネットにつながずに動く（取得部分は偽のレスポンスで試す）テストです。
