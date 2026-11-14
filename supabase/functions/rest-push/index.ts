// 休憩タイマーの終了をWeb Pushで知らせる。
// アプリが rest_timers に {timer_id, fire_at} を書き、この関数を呼ぶ。
// 関数は fire_at まで待ち、timer_id が変わっていなければ（取り消し・変更がなければ）通知を送る。
// 長い待ち時間は処理時間の上限を超えないよう、自分自身を呼び直してリレーする。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT = 110_000; // 1回の呼び出しで待つ最大時間

let secrets: Record<string, string> | null = null;
async function getSecrets() {
  if (secrets) return secrets;
  const { data, error } = await admin.from("app_secrets").select("name,value");
  if (error) throw error;
  secrets = Object.fromEntries(data.map((r) => [r.name, r.value]));
  webpush.setVapidDetails("https://quruquruyuki.github.io/workout-log/", secrets.vapid_public, secrets.vapid_private);
  return secrets;
}

async function current(userId: string) {
  const { data } = await admin.from("rest_timers").select("timer_id,fire_at,note").eq("user_id", userId).maybeSingle();
  return data;
}

async function send(userId: string, note: string | null) {
  const { data: subs } = await admin.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", userId);
  const payload = JSON.stringify({ title: "⏱ 休憩終了", body: note || "次のセットへ！", tag: "rest" });
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60, urgency: "high" });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, String(e));
    }
  }
}

async function run(userId: string, timerId: string) {
  const started = Date.now();
  while (true) {
    const t = await current(userId);
    if (!t || t.timer_id !== timerId) return; // 取り消し・変更された
    const rem = new Date(t.fire_at).getTime() - Date.now();
    if (rem <= 300) {
      await admin.from("rest_timers").delete().eq("user_id", userId).eq("timer_id", timerId);
      await send(userId, t.note);
      return;
    }
    const budget = MAX_WAIT - (Date.now() - started);
    if (rem > budget) {
      await sleep(Math.max(0, budget - 5_000));
      const s = await getSecrets();
      await fetch(`${SB_URL}/functions/v1/rest-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relay: s.relay_token, user_id: userId, timer_id: timerId }),
      });
      return;
    }
    await sleep(rem);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const s = await getSecrets();
    let userId: string | null = null;
    if (body.relay) {
      if (body.relay !== s.relay_token) return new Response("forbidden", { status: 403, headers: CORS });
      userId = body.user_id;
    } else {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await admin.auth.getUser(jwt);
      if (error || !data.user) return new Response("unauthorized", { status: 401, headers: CORS });
      userId = data.user.id;
    }
    if (body.test) { await send(userId!, "テスト通知です。休憩が終わるとこう届きます"); return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "content-type": "application/json" } }); }
    if (!body.timer_id) return new Response("bad request", { status: 400, headers: CORS });
    EdgeRuntime.waitUntil(run(userId!, body.timer_id));
    return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { ...CORS, "content-type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  }
});
