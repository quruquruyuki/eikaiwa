# 英会話

iPhone向けの英会話練習アプリ（GitHub Pages＋Supabase）。

- **会話**：場面（学会・医師への製品説明・ホテルなど）を選んで、AIと音声で会話。終わったら添削と覚えたい表現
- **聞き取り（ディクテーション）**：AIが作った英文・貼りつけた英文・フレーズ帳を聞いて書き取り、単語ごとに採点
- **シャドーイング**：リピート／シャドーイングの2種類。自分の声を聞き取って、お手本と単語ごとに比べる
- **フレーズ帳**：間隔をあけて復習（覚えた／まだ）
- **記録**：連続日数・12週間のカレンダー・過去の添削

## しくみ

- 画面：`index.html` だけ（GitHub Pages）
- データ：Supabase「quruquruyuki's Project」の `ek_sessions`（練習の記録）と `ek_phrases`（フレーズ帳）。本人の行だけ読めるように RLS 設定済み
- AI：Edge Function `eikaiwa`（`supabase/functions/eikaiwa/index.ts`）
  - 聞き取り：OpenAI（`transcribe_model`）
  - 会話の相手：Claude（`chat_model`、速さ重視）
  - 添削・教材づくり：Claude（`review_model`）
  - 読み上げ：OpenAI（`tts_model` / `tts_voice`）。失敗したときは端末の声
- モデルは共通設定 `app_settings` の `eikaiwa` で切り替え
- 使うシークレット：`ALLOWED_EMAIL`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`SUPABASE_ANON_KEY`（ほかのアプリと共通）
