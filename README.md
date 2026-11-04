# 運動ログ（PWA）

筋トレ・ランを記録して月ごとにまとめて見られる、スマホ向けWebアプリ。
画面はGitHub Pages、データはSupabaseに保存する。

## 構成
- `index.html` / `app.js` … 画面とロジック（ビルド不要）
- `config.js` … Supabase の URL と公開キー（anon / publishable）
- `sw.js` / `manifest.webmanifest` / `icons/` … ホーム画面追加・オフライン対応
- `supabase/schema.sql` … テーブルとアクセス制限（RLS）

## セットアップ
1. Supabase の SQL Editor で `supabase/schema.sql` を実行
2. Supabase の Authentication → URL Configuration の Site URL に公開URLを設定
3. `config.js` に Project URL と anon / publishable キーを入れる
4. GitHub Pages（Settings → Pages → Branch: main / root）で公開
5. iPhone の Safari で開き、共有 → 「ホーム画面に追加」

## メモ
- 記録は本人のアカウントからだけ読み書きできる（RLS）。
- オフライン中の記録は端末に保存され、オンラインに戻ると自動で送信される。
- Supabase 無料枠は1週間アクセスがないと一時停止する（データは残り、管理画面から再開できる）。
