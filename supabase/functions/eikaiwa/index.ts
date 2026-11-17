// 英会話アプリ用 Supabase Edge Function
// action:
//   transcribe（話した英語の聞き取り・multipart） / chat（会話の相手） / hint（詰まったときの助け舟）
//   review（会話後の添削） / material（ディクテーション・シャドーイングの教材） / tts（英語の読み上げ）
// 使うシークレット: ALLOWED_EMAIL, OPENAI_API_KEY（openai_api_key でも可）, ANTHROPIC_API_KEY, SUPABASE_ANON_KEY
// モデルは共通設定（app_settings / eikaiwa）で切り替える
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const APP = "eikaiwa";

const env = (...keys: string[]) => {
  for (const k of keys) {
    const v = Deno.env.get(k) ?? Deno.env.get(k.toLowerCase()) ?? Deno.env.get(k.toUpperCase());
    if (v) return v;
  }
  return "";
};

// ── 全アプリ共通の設定（app_settings）。1分間は使い回す ──
const SETTINGS_TTL = 60_000;
let settingsCache: { at: number; map: Record<string, unknown> } | null = null;
async function appSettings(): Promise<Record<string, unknown>> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.map;
  const map: Record<string, unknown> = {};
  try {
    const key = env("SUPABASE_SERVICE_ROLE_KEY");
    const q = `select=app,key,value&app=in.${encodeURIComponent(`("global","${APP}")`)}`;
    const r = await fetch(`${env("SUPABASE_URL")}/rest/v1/app_settings?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.ok) for (const row of await r.json()) map[row.app === "global" ? `global.${row.key}` : row.key] = row.value;
    else console.error("app_settings", r.status, await r.text());
  } catch (e) { console.error("app_settings", e); }
  settingsCache = { at: Date.now(), map };
  return map;
}
async function setting(key: string, fallback: string): Promise<string> {
  const v = (await appSettings())[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
async function usdOf(model: string, tin: number, tout: number, ain = 0): Promise<number | null> {
  const prices = ((await appSettings())["global.prices"] ?? {}) as Record<string, any>;
  const p = prices[model];
  if (!p || typeof p.in !== "number") return null;
  return (ain * (p.ain ?? p.in) + tin * p.in + tout * p.out) / 1e6;
}

// ログイン中のユーザーが ALLOWED_EMAIL 本人かを確かめる
async function isAllowedUser(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const r = await fetch(`${env("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env("SUPABASE_ANON_KEY") },
  });
  if (!r.ok) return false;
  const u = await r.json();
  const allowed = env("ALLOWED_EMAIL").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return !!u.email && allowed.includes(String(u.email).toLowerCase());
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ対応" }, 405);
  if (!(await isAllowedUser(req))) return json({ error: "ログインし直してください" }, 401);
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) return json(await transcribe(await req.formData()));
    const b = await req.json();
    switch (b.action) {
      case "chat": return json(await chat(b));
      case "hint": return json(await hint(b));
      case "review": return json(await review(b));
      case "material": return json(await material(b));
      case "tts": return json(await tts(b));
    }
    return json({ error: "不明な処理" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// ---------- 聞き取り ----------
async function transcribe(form: FormData) {
  const file = form.get("file") as File;
  if (!file) throw new Error("音声がありません");
  const model = await setting("transcribe_model", "gpt-transcribe");
  const fd = new FormData();
  fd.append("file", file, file.name || "speech.m4a");
  fd.append("model", model);
  fd.append("language", "en");
  fd.append("response_format", "json");
  const prompt = String(form.get("prompt") ?? "");
  // 言い間違いもそのまま書き起こしてほしい（添削・採点に使うため）
  fd.append("prompt", `Transcribe exactly what the speaker says, including grammar mistakes and fillers. Do not correct. ${prompt}`.slice(0, 800));
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` }, body: fd,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`聞き取り: ${d.error?.message ?? r.status}`);
  const sec = Number(form.get("seconds") ?? 0);
  const prices = ((await appSettings())["global.prices"] ?? {}) as Record<string, any>;
  const perMin = prices[`${model}_per_min`];
  const usd = typeof perMin === "number" && sec ? (sec / 60) * perMin : null;
  return { text: (d.text ?? "").trim(), usd };
}

// ---------- Claude 呼び出し（決まった入れ物に記入させる） ----------
async function claude(model: string, system: string, messages: any[], tool: any, maxTokens = 1200) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools: [tool], tool_choice: { type: "tool", name: tool.name } }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`AI: ${d.error?.message ?? r.status}`);
  const use = (d.content ?? []).find((c: any) => c.type === "tool_use");
  if (!use) throw new Error("AIの返事を読み取れませんでした");
  const usd = await usdOf(model, d.usage?.input_tokens ?? 0, d.usage?.output_tokens ?? 0);
  return { out: use.input, usd, model };
}

const LEVEL: Record<string, string> = {
  beginner: "The learner is a beginner (around CEFR A2). Use short, simple sentences and common words. Speak slowly and clearly.",
  intermediate: "The learner is intermediate (around CEFR B1). Use natural but clear English; avoid rare idioms.",
  advanced: "The learner is advanced (around CEFR B2-C1). Speak naturally as you would with a colleague.",
};
const levelOf = (l: string) => LEVEL[l] ?? LEVEL.intermediate;

// 会話の履歴をClaudeの形に（先頭は必ずユーザー）
function toMessages(history: { role: string; text: string }[]) {
  const msgs = history.filter((m) => m.text?.trim()).map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text }));
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: "(The learner is ready. Please start the conversation.)" });
  // 同じ役割が続くとエラーになるのでまとめる
  const merged: any[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content; else merged.push({ ...m });
  }
  if (merged[merged.length - 1].role !== "user") merged.push({ role: "user", content: "(continue)" });
  return merged;
}

// ---------- 会話の相手 ----------
const CHAT_TOOL = {
  name: "reply",
  description: "Your next line in the conversation",
  input_schema: {
    type: "object",
    properties: {
      en: { type: "string", description: "What you say, in English. 1-3 sentences. Usually end with a question so the learner keeps talking." },
      ja: { type: "string", description: "Natural Japanese translation of en" },
    },
    required: ["en", "ja"],
  },
};
async function chat(b: any) {
  const { scene = "Casual small talk", level = "intermediate", history = [] } = b;
  const system = `You are an English conversation partner for a Japanese learner. Stay in role for this scene:
${scene}
${levelOf(level)}
Rules:
- Keep each turn short (1-3 sentences) so the learner speaks more than you.
- Do not correct mistakes during the conversation; just respond naturally (corrections come later).
- If the learner writes in Japanese or seems stuck, gently help in simple English and keep going.
- If this is the first turn, open the scene naturally in character.`;
  const model = await setting("chat_model", "claude-haiku-5-5");
  const r = await claude(model, system, toMessages(history), CHAT_TOOL, 500);
  return { en: r.out.en, ja: r.out.ja, usd: r.usd };
}

// ---------- 助け舟 ----------
const HINT_TOOL = {
  name: "hint",
  description: "Help the stuck learner",
  input_schema: {
    type: "object",
    properties: {
      ja: { type: "string", description: "何をどう答えればよいかの日本語のヒント（1〜2文）" },
      examples: { type: "array", items: { type: "string" }, description: "The learner could say one of these (2 short English examples at their level)" },
    },
    required: ["ja", "examples"],
  },
};
async function hint(b: any) {
  const { scene = "", level = "intermediate", history = [], want = "" } = b;
  const log = history.map((m: any) => `${m.role === "ai" ? "Partner" : "Learner"}: ${m.text}`).join("\n");
  const system = `You help a Japanese learner of English who is stuck in a role-play conversation. Scene: ${scene}\n${levelOf(level)}`;
  const content = `Conversation so far:\n${log || "(none)"}\n\n${want ? `The learner wants to say (in Japanese): ${want}\n` : ""}Give a hint for the learner's next reply.`;
  const model = await setting("chat_model", "claude-haiku-5-5");
  const r = await claude(model, system, [{ role: "user", content }], HINT_TOOL, 500);
  return { ...r.out, usd: r.usd };
}

// ---------- 会話後の添削 ----------
const REVIEW_TOOL = {
  name: "review",
  description: "Feedback on the learner's English after the conversation",
  input_schema: {
    type: "object",
    properties: {
      overall_ja: { type: "string", description: "全体の講評（日本語で2〜4文。良かった点と次に意識する点）" },
      score: { type: "integer", minimum: 0, maximum: 100, description: "伝わりやすさと正確さの目安点" },
      corrections: {
        type: "array",
        description: "学習者の発言のうち、直すとよいもの（最大8件、重要な順）。問題ない発言は入れない",
        items: {
          type: "object",
          properties: {
            said: { type: "string", description: "学習者が実際に言った英文" },
            better: { type: "string", description: "より自然・正確な言い方" },
            point_ja: { type: "string", description: "どこをなぜ直したか（日本語で短く）" },
          },
          required: ["said", "better", "point_ja"],
        },
      },
      good_ja: { type: "array", items: { type: "string" }, description: "上手に言えていた表現（日本語で短く、最大3件）" },
      phrases: {
        type: "array",
        description: "この場面で覚えておくと役立つ英語表現（4〜6件）。添削で出た言い方を含めてよい",
        items: {
          type: "object",
          properties: { en: { type: "string" }, ja: { type: "string" }, note: { type: "string", description: "使いどころ（日本語で短く）" } },
          required: ["en", "ja"],
        },
      },
    },
    required: ["overall_ja", "score", "corrections", "good_ja", "phrases"],
  },
};
async function review(b: any) {
  const { scene = "", level = "intermediate", history = [] } = b;
  const log = history.map((m: any) => `${m.role === "ai" ? "Partner" : "Learner"}: ${m.text}`).join("\n");
  if (!history.some((m: any) => m.role !== "ai" && m.text?.trim())) throw new Error("まだ話していません");
  const system = `あなたは日本人の英語学習者を教える、優しく的確な英会話コーチです。場面: ${scene}\n${levelOf(level)}
学習者の発言（Learner）は音声の書き起こしなので、句読点や大文字小文字の違いは指摘しないでください。文法・語彙・自然さに集中してください。`;
  const model = await setting("review_model", "claude-sonnet-5-5");
  const r = await claude(model, system, [{ role: "user", content: `Conversation:\n${log}\n\nPlease review the learner's English.` }], REVIEW_TOOL, 3000);
  return { ...r.out, usd: r.usd };
}

// ---------- 教材（ディクテーション・シャドーイング） ----------
const MATERIAL_TOOL = {
  name: "material",
  description: "Practice sentences for dictation and shadowing",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "教材の短いタイトル（日本語）" },
      sentences: {
        type: "array",
        items: {
          type: "object",
          properties: { en: { type: "string" }, ja: { type: "string", description: "自然な日本語訳" } },
          required: ["en", "ja"],
        },
      },
    },
    required: ["title", "sentences"],
  },
};
async function material(b: any) {
  const { scene = "Casual small talk", level = "intermediate", count = 6, text = "", style = "dialogue" } = b;
  const n = Math.min(12, Math.max(3, Number(count) || 6));
  let content: string;
  if (text.trim()) {
    content = `Split the following English text into practice sentences (one sentence each, keep the original wording; fix only obvious typos). Translate each into Japanese.\n\n${text.slice(0, 6000)}`;
  } else {
    content = `Write ${n} English sentences for listening (dictation) and shadowing practice.
Scene: ${scene}
${levelOf(level)}
Style: ${style === "monologue" ? "a short, coherent talk by one speaker" : "a natural dialogue between two people (do not write speaker names)"}.
Use expressions people really use in this scene. Each sentence 6-20 words.`;
  }
  const model = await setting("review_model", "claude-sonnet-5-5");
  const r = await claude(model, "You create English listening materials for Japanese learners.", [{ role: "user", content }], MATERIAL_TOOL, 3000);
  return { ...r.out, usd: r.usd };
}

// ---------- 読み上げ ----------
async function tts(b: any) {
  const text = String(b.text ?? "").slice(0, 1500);
  if (!text.trim()) throw new Error("読み上げる文がありません");
  const model = await setting("tts_model", "gpt-4o-mini-tts");
  const voice = b.voice || await setting("tts_voice", "alloy");
  const body: any = { model, voice, input: text, response_format: "mp3" };
  if (model.includes("tts") && !model.startsWith("tts-")) body.instructions = "Speak clear, natural American English at a moderate pace, like a friendly teacher.";
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`読み上げ: ${t.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  return { audio: encodeBase64(buf), mime: "audio/mpeg" };
}
