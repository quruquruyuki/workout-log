import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CFG = window.WL_CONFIG || {};
const sb = createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
let session = null;

/* ---------- data layer (Supabase + offline queue) ---------- */
const TABLE = "workouts";
let server = [];   // confirmed rows
let pending = [];  // [{op:"ins",row}|{op:"del",id}]
let flushing = false;
const lsKey = k => "wl_" + k + "_" + (session?.user?.id || "anon");
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(lsKey(k))) ?? d } catch (_) { return d } };
const lsSet = (k, v) => { try { localStorage.setItem(lsKey(k), JSON.stringify(v)) } catch (_) {} };

const fromRow = r => ({ id: r.id, date: r.date, type: r.type, part: r.part, exercise: r.exercise, weight: r.weight,
  reps: r.reps, sets: r.sets, min: r.minutes, km: r.km, place: r.place, memo: r.memo, ts: r.created_at || "" });
const toRow = x => ({ id: x.id, date: x.date, type: x.type, part: x.part ?? null, exercise: x.exercise ?? null,
  weight: x.weight ?? null, reps: x.reps ?? null, sets: x.sets ?? null, minutes: x.min ?? null, km: x.km ?? null,
  place: x.place ?? null, memo: x.memo ?? null, created_at: x.ts });

function recompute() {
  const dels = new Set(pending.filter(p => p.op === "del").map(p => p.id));
  entries = server.filter(x => !dels.has(x.id))
    .concat(pending.filter(p => p.op === "ins").map(p => ({ ...p.row, _pend: true })));
  lsSet("server", server); lsSet("pending", pending);
  renderAll();
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}
function addEntry(data) {
  const row = { ...data, id: uuid(), ts: new Date().toISOString() };
  pending.push({ op: "ins", row }); recompute(); flush();
}
function removeEntry(id) {
  const i = pending.findIndex(p => p.op === "ins" && p.row.id === id);
  if (i >= 0) pending.splice(i, 1); else pending.push({ op: "del", id });
  recompute(); flush();
}
async function flush() {
  if (flushing || !session || !navigator.onLine) return;
  flushing = true;
  try {
    while (pending.length) {
      const p = pending[0];
      if (p.op === "ins") {
        const { error } = await sb.from(TABLE).upsert(toRow(p.row));
        if (error) throw error;
        server.push({ ...p.row });
      } else {
        const { error } = await sb.from(TABLE).delete().eq("id", p.id);
        if (error) throw error;
        server = server.filter(x => x.id !== p.id);
      }
      pending.shift(); recompute();
    }
  } catch (e) { console.warn("flush failed", e); }
  flushing = false;
}
async function load() {
  server = lsGet("server", []); pending = lsGet("pending", []);
  ready = true; updateSave(); recompute();
  if (!navigator.onLine) { setStatus("オフラインです。記録は端末に保存され、オンラインになると送信されます。"); return; }
  const all = []; let from = 0;
  try {
    for (;;) {
      const { data, error } = await sb.from(TABLE).select("*").order("date").range(from, from + 999);
      if (error) throw error;
      all.push(...data); if (data.length < 1000) break; from += 1000;
    }
    server = all.map(fromRow); setStatus(""); recompute(); flush();
  } catch (e) {
    console.warn(e);
    setStatus("サーバーから記録を読み込めませんでした。表示は前回保存した内容です。");
  }
}
window.addEventListener("online", () => { setStatus(""); flush(); load(); });
window.addEventListener("offline", () => setStatus("オフラインです。記録は端末に保存され、オンラインになると送信されます。"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session) flush(); });

const PARTS=["胸","背中","肩","腕","臀","脚","腹・体幹"];
const PRESETS={"胸":["チェストプレス","プッシュアップ","ペックフライ"],"背中":["ラットプルダウン","ケーブルプルオーバー","ニーリングワンハンドロウ","ローロウ","ワンハンドロウ","ロウイング","インバーテッドロウ"],"肩":["サイドレイズ","ショルダープレス","フェイスプル","リアデルト"],"腕":["フレンチプレス","トライセプスダウン","トライセプスキックバック"],"臀":["ブルガリアンスクワット","ヒップリフト","アブダクター","チューブステップ","ゴブレットスクワット"],"脚":["アダクター","プローンレッグカール"],"腹・体幹":["デッドバグ","プランク","リバースクランチ","レッグレイズ","サイドプランク・ローテーション"]};
const MONTHS=["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const today=new Date();
let entries=[],ready=false,saving=false;
const st={type:"strength",part:"胸",ex:null,custom:false,place:"屋内",y:today.getFullYear(),m:today.getMonth()};

function toast(t){const e=$("toast");e.textContent=t;e.classList.add("on");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("on"),1800)}
function setStatus(t){const s=$("status");if(t){s.textContent=t;s.classList.remove("hidden")}else s.classList.add("hidden")}

/* ---------- routing ---------- */
function route(){if(!session)return;const v=location.hash==="#month"?"month":"log";
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("on",b.dataset.v===v));
  $("v-log").classList.toggle("hidden",v!=="log");$("saveBar").classList.toggle("hidden",v!=="log");$("v-month").classList.toggle("hidden",v!=="month");
  if(v==="month")renderMonth();window.scrollTo(0,0)}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{location.hash=b.dataset.v});
window.addEventListener("hashchange",route);

/* ---------- log form ---------- */
$("date").value=ymd(today);
function syncQuick(){const v=$("date").value;[...$("dayQuick").children].forEach(b=>{const d=new Date();d.setDate(d.getDate()+ +b.dataset.o);b.classList.toggle("on",ymd(d)===v)})}
$("date").onchange=()=>{syncQuick();renderDay()};
$("dayQuick").onclick=e=>{const b=e.target.closest("button");if(!b)return;const d=new Date();d.setDate(d.getDate()+ +b.dataset.o);$("date").value=ymd(d);syncQuick();renderDay()};
syncQuick();
document.querySelectorAll(".stp button").forEach(b=>b.onclick=()=>{const i=$(b.dataset.s),d=+b.dataset.d;
  let v=parseFloat(i.value);if(isNaN(v))v=0;
  if(b.dataset.s==="w"){const step=v<5||(v===5&&d<0)?0.5:1;v=Math.max(0,Math.round((v+d*step)*10)/10);i.value=v||""}
  else{i.value=Math.max(1,v+d)}
  if(navigator.vibrate)try{navigator.vibrate(8)}catch(_){}});
$("typeSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;st.type=b.dataset.t;
  [...$("typeSeg").children].forEach(x=>x.classList.toggle("on",x===b));
  $("fStrength").classList.toggle("hidden",st.type!=="strength");$("fRun").classList.toggle("hidden",st.type!=="run");updateSave()};
$("placeSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;st.place=b.dataset.p;[...$("placeSeg").children].forEach(x=>x.classList.toggle("on",x===b))};

function renderParts(){$("partSeg").innerHTML=PARTS.map(p=>`<button class="chip ${p===st.part?"on":""}" data-p="${p}">${p}</button>`).join("")}
$("partSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;st.part=b.dataset.p;st.ex=null;st.custom=false;renderParts();renderEx()};
function exNames(part){const used=entries.filter(x=>x.type==="strength"&&x.part===part).map(x=>x.exercise);
  return [...new Set([...PRESETS[part],...used])]}
function renderEx(){const names=exNames(st.part);
  $("exSeg").innerHTML=names.map(n=>`<button class="chip ${n===st.ex&&!st.custom?"on":""}" data-e="${esc(n)}">${esc(n)}</button>`).join("")+`<button class="chip add ${st.custom?"on":""}" data-e="">＋その他</button>`;
  $("exCustom").classList.toggle("hidden",!st.custom);updatePrev();updateSave()}
$("exSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.e===""){st.custom=true;st.ex=null;renderEx();$("exCustom").focus();return}
  st.custom=false;st.ex=b.dataset.e;renderEx();prefill()};
$("exCustom").oninput=updateSave;
function lastOf(name){return entries.filter(x=>x.type==="strength"&&x.exercise===name).sort((a,b)=>(b.date+b.ts).localeCompare(a.date+a.ts))[0]}
function prefill(){const l=lastOf(st.ex);if(l){$("w").value=l.weight??"";$("reps").value=l.reps??"";$("sets").value=l.sets??3}}
function updatePrev(){const l=st.ex&&lastOf(st.ex);$("prevHint").textContent=l?`前回 ${l.date.slice(5).replace("-","/")}：${fmtSet(l)}`:""}
function curEx(){return st.custom?$("exCustom").value.trim():st.ex}
function updateSave(){$("save").disabled=!ready||saving||(st.type==="strength"&&!curEx())}

function fmtSet(x){return [x.weight?x.weight+"kg":"",(x.reps?x.reps+"回":"")+(x.sets?"×"+x.sets:"")].filter(Boolean).join(" ")}

$("save").onclick=async()=>{if(!ready)return;let data;
  const date=$("date").value||ymd(today);
  if(st.type==="strength"){const ex=curEx();if(!ex)return;
    const w=parseFloat($("w").value);const s=parseInt($("sets").value,10);
    data={type:"strength",date,part:st.part,exercise:ex,weight:isNaN(w)?null:w,reps:$("reps").value.trim(),sets:isNaN(s)?1:s};
  }else{const mn=parseFloat($("rmin").value),km=parseFloat($("rkm").value);
    if(isNaN(mn)&&isNaN(km)){toast("時間か距離を入れてください");return}
    data={type:"run",date,min:isNaN(mn)?0:mn,km:isNaN(km)?0:km,place:st.place,memo:$("rmemo").value.trim()};}
  saving=true;updateSave();
  try{addEntry(data);toast(navigator.onLine?"記録しました":"記録しました（オンラインになったら送信）");
    if(st.type==="run"){$("rmin").value="";$("rkm").value="";$("rmemo").value=""}
    if(st.custom){st.custom=false;st.ex=data.exercise;$("exCustom").value=""}
  }catch(e){toast("保存できませんでした。もう一度お試しください")}
  saving=false;updateSave();renderEx()};

function renderDay(){const d=$("date").value;const list=entries.filter(x=>x.date===d).sort((a,b)=>a.ts.localeCompare(b.ts));
  $("dayCap").textContent=`${d.slice(5).replace("-","/")} の記録`;
  $("dayList").innerHTML=list.length?list.map(x=>`<div class="item"><div class="t"><div>${x.type==="run"?"🏃 ラン":"🏋️ "+esc(x.exercise)}${x._pend?'<span class="pend">未送信</span>':""}</div><div>${x.type==="run"?`${x.min}分・${x.km}km・${esc(x.place)}${x.memo?"　"+esc(x.memo):""}`:esc(x.part)+"　"+esc(fmtSet(x))}</div></div><button class="del" data-id="${x.id}">削除</button></div>`).join(""):`<div class="empty">まだ記録はありません</div>`}
$("dayList").onclick=async e=>{const b=e.target.closest(".del");if(!b)return;
  if(!b.classList.contains("sure")){b.classList.add("sure");b.textContent="本当に削除";setTimeout(()=>{b.classList.remove("sure");b.textContent="削除"},3000);return}
  b.disabled=true;removeEntry(b.dataset.id);toast("削除しました")};

/* ---------- month ---------- */
$("prevM").onclick=()=>{st.m--;if(st.m<0){st.m=11;st.y--}renderMonth()};
$("nextM").onclick=()=>{st.m++;if(st.m>11){st.m=0;st.y++}renderMonth()};
(()=>{let sx=0,sy=0;const el=$("v-month");
  el.addEventListener("touchstart",e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY},{passive:true});
  el.addEventListener("touchend",e=>{const dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.5)(dx<0?$("nextM"):$("prevM")).click()},{passive:true})})();
const mkey=(y,m)=>y+"-"+pad(m+1);

function bodySvg(v){/* v: part -> 0..1 */
  const f=p=>{const a=v[p]||0;return a?`rgba(255,255,255,${(0.25+0.7*a).toFixed(2)})`:"#2a2c33"};
  const st_='stroke="#0e0f12" stroke-width="1.5"';
  return `<svg viewBox="0 0 200 230" xmlns="http://www.w3.org/2000/svg">
  <g ${st_}>
   <circle cx="50" cy="18" r="12" fill="#2a2c33"/>
   <ellipse cx="27" cy="45" rx="9" ry="8" fill="${f("肩")}"/><ellipse cx="73" cy="45" rx="9" ry="8" fill="${f("肩")}"/>
   <rect x="34" y="38" width="15" height="22" rx="6" fill="${f("胸")}"/><rect x="51" y="38" width="15" height="22" rx="6" fill="${f("胸")}"/>
   <rect x="37" y="62" width="26" height="42" rx="7" fill="${f("腹・体幹")}"/>
   <rect x="15" y="54" width="10" height="50" rx="5" fill="${f("腕")}"/><rect x="75" y="54" width="10" height="50" rx="5" fill="${f("腕")}"/>
   <rect x="34" y="108" width="15" height="100" rx="7" fill="${f("脚")}"/><rect x="51" y="108" width="15" height="100" rx="7" fill="${f("脚")}"/>
  </g>
  <g ${st_}>
   <circle cx="150" cy="18" r="12" fill="#2a2c33"/>
   <ellipse cx="127" cy="45" rx="9" ry="8" fill="${f("肩")}"/><ellipse cx="173" cy="45" rx="9" ry="8" fill="${f("肩")}"/>
   <path d="M134 36 L166 36 L163 92 L137 92 Z" fill="${f("背中")}"/>
   <rect x="115" y="54" width="10" height="50" rx="5" fill="${f("腕")}"/><rect x="175" y="54" width="10" height="50" rx="5" fill="${f("腕")}"/>
   <ellipse cx="142" cy="106" rx="9" ry="12" fill="${f("臀")}"/><ellipse cx="158" cy="106" rx="9" ry="12" fill="${f("臀")}"/>
   <rect x="134" y="120" width="15" height="88" rx="7" fill="${f("脚")}"/><rect x="151" y="120" width="15" height="88" rx="7" fill="${f("脚")}"/>
  </g>
  <text x="50" y="226" fill="#7d7f88" font-size="8" text-anchor="middle" font-family="Jost" letter-spacing="2">FRONT</text>
  <text x="150" y="226" fill="#7d7f88" font-size="8" text-anchor="middle" font-family="Jost" letter-spacing="2">BACK</text></svg>`}

function renderMonth(){const y=st.y,m=st.m,key=mkey(y,m);
  $("mNum").textContent=m+1;$("mName").textContent=MONTHS[m]+" "+y;
  const pm=m===0?11:m-1,py=m===0?y-1:y,pkey=mkey(py,pm);
  const inM=entries.filter(x=>x.date&&x.date.startsWith(key));
  const str=inM.filter(x=>x.type==="strength"),runs=inM.filter(x=>x.type==="run").sort((a,b)=>a.date.localeCompare(b.date));
  const prevStr=entries.filter(x=>x.type==="strength"&&x.date&&x.date.startsWith(pkey));
  const nd=new Date(y,m+1,0).getDate();
  let h="";
  /* calendar */
  const actDays={};inM.forEach(x=>{(actDays[x.date]=actDays[x.date]||new Set()).add(x.type)});
  const first=(new Date(y,m,1).getDay()+6)%7;
  h+=`<div class="stats" style="margin-top:6px"><div><b>${str.length?new Set(str.map(x=>x.date)).size:0}</b><span>🏋️ 筋トレ</span></div><div><b>${runs.length}</b><span>🏃 ラン</span></div><div><b>${Object.keys(actDays).length}</b><span>活動日</span></div></div>`;
  h+=`<div class="cal">${["MON","TUE","WED","THU","FRI","SAT","SUN"].map(d=>`<div class="dow">${d}</div>`).join("")}`;
  for(let i=0;i<first;i++)h+=`<div class="out"></div>`;
  for(let d=1;d<=nd;d++){const k=key+"-"+pad(d),s=actDays[k];
    h+=`<div class="${s?"act":""}"><div class="d">${d}</div><div class="ic">${s?(s.has("strength")?"🏋️":"")+(s.has("run")?"🏃":""):""}</div></div>`}
  const rest=(7-(first+nd)%7)%7;for(let i=0;i<rest;i++)h+=`<div class="out"></div>`;
  h+=`</div>`;

  /* strength summary */
  const sets=a=>a.reduce((s,x)=>s+(x.sets||0),0);
  h+=`<div class="sec"><div class="sech"><span>STRENGTH — 筋トレ</span></div>`;
  if(!str.length){h+=`<div class="empty">この月の筋トレ記録はまだありません</div></div>`}
  else{
    h+=`<div class="stats"><div><b>${new Set(str.map(x=>x.date)).size}</b><span>DAYS</span></div><div><b>${sets(str)}</b><span>SETS</span></div><div><b>${new Set(str.map(x=>x.exercise)).size}</b><span>EXERCISES</span></div></div>`;
    const cur={},prv={};PARTS.forEach(p=>{cur[p]=sets(str.filter(x=>x.part===p));prv[p]=sets(prevStr.filter(x=>x.part===p))});
    const mx=Math.max(1,...PARTS.map(p=>Math.max(cur[p],prv[p])));
    const vis={};PARTS.forEach(p=>vis[p]=cur[p]/mx);
    h+=`<div class="body">${bodySvg(vis)}<div class="parts">${PARTS.map(p=>{const d=cur[p]-prv[p];
      return `<div class="prow"><div class="top"><span>${p}</span><span class="v">${cur[p]}</span><span class="dl">${d>0?"+"+d:d<0?d:"±0"}</span></div><div class="bar"><i style="width:${cur[p]/mx*100}%"></i>${prv[p]?`<s style="left:${prv[p]/mx*100}%"></s>`:""}</div></div>`}).join("")}<div class="note">細い縦線は前月のセット数</div></div></div>`;
    h+=`<div class="sech" style="margin-top:26px"><span>EXERCISES — 種目別</span></div>`;
    PARTS.forEach(p=>{const ps=str.filter(x=>x.part===p);if(!ps.length)return;
      const byEx={};ps.forEach(x=>(byEx[x.exercise]=byEx[x.exercise]||[]).push(x));
      const names=Object.keys(byEx).sort((a,b)=>sets(byEx[b])-sets(byEx[a]));
      h+=`<div class="grp">${p}<small>${names.length}種目・${sets(ps)}セット</small></div>`;
      names.forEach(n=>{const a=byEx[n],days=new Set(a.map(x=>+x.date.slice(8)));
        const last=a.slice().sort((x,y)=>(y.date+y.ts).localeCompare(x.date+x.ts))[0];
        let dots="";for(let d=1;d<=nd;d++)dots+=`<i class="${days.has(d)?"on":""}"></i>`;
        h+=`<div class="ex"><div class="a"><span>${esc(n)}</span><span><b>${days.size}</b>日・<b>${sets(a)}</b>セット</span></div><div class="b"><div class="dots">${dots}</div><span>${esc(fmtSet(last))}</span></div></div>`})});
    h+=`</div>`}

  /* run summary */
  h+=`<div class="sec"><div class="sech"><span>RUN — ラン</span></div>`;
  if(!runs.length)h+=`<div class="empty">この月のラン記録はまだありません</div>`;
  else{const km=runs.reduce((s,x)=>s+(x.km||0),0),mn=runs.reduce((s,x)=>s+(x.min||0),0),mk=Math.max(...runs.map(x=>x.km||0),0.01);
    h+=`<div class="stats"><div><b>${runs.length}</b><span>RUNS</span></div><div><b>${km.toFixed(1)}<i>km</i></b><span>DISTANCE</span></div><div><b>${Math.floor(mn/60)}<i>h</i>${pad(Math.round(mn%60))}<i>m</i></b><span>TIME</span></div></div>`;
    const wd="日月火水木金土";
    runs.forEach(x=>{const dt=new Date(x.date+"T00:00");
      h+=`<div class="run"><div class="a"><span>${dt.getMonth()+1}/${dt.getDate()}<small>${wd[dt.getDay()]}・${esc(x.place)}</small></span><span>${x.min}分・${(x.km||0).toFixed(2)}km</span></div><div class="b"><div class="bar"><i style="width:${(x.km||0)/mk*100}%"></i></div><span>${esc(x.memo)}</span></div></div>`})}
  h+=`</div>`;
  $("monthBody").innerHTML=h}

/* ---------- csv ---------- */
function buildCsv(){const rows=[["日付","種類","部位","種目","重さkg","回数","セット","時間分","距離km","場所","内容"]];
  entries.slice().sort((a,b)=>(a.date+a.ts).localeCompare(b.date+b.ts)).forEach(x=>rows.push(x.type==="run"?[x.date,"ラン","","","","","",x.min,x.km,x.place,x.memo]:[x.date,"筋トレ",x.part,x.exercise,x.weight??"",x.reps,x.sets,"","","",""]));
  return rows.map(r=>r.map(v=>{v=String(v??"");return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(",")).join("\n")}
$("csvDl").onclick=()=>{const blob=new Blob(["\ufeff"+buildCsv()],{type:"text/csv"});const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download="workout-log-"+ymd(new Date())+".csv";document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)};
$("csv").onclick=async()=>{const csv=buildCsv();
  try{await navigator.clipboard.writeText(csv);toast(`${entries.length}件をコピーしました`)}
  catch(_){const t=$("csvBox");t.value=csv;t.classList.remove("hidden");t.select();toast("下の欄から全選択してコピーしてください")}};

function renderAll(){renderEx();renderDay();if(!$("v-month").classList.contains("hidden"))renderMonth()}


/* ---------- auth ---------- */
let signUpMode = false;
function showApp(on) {
  $("auth").classList.toggle("hidden", on);
  $("nav").classList.toggle("hidden", !on);
  if (on) route(); else { $("v-log").classList.add("hidden"); $("v-month").classList.add("hidden"); $("saveBar").classList.add("hidden"); }
}
$("authSwitch").onclick = () => {
  signUpMode = !signUpMode;
  $("authBtn").textContent = signUpMode ? "新規登録" : "ログイン";
  $("authSwitch").textContent = signUpMode ? "登録済みの方はログイン" : "はじめての方は新規登録";
  $("pass").autocomplete = signUpMode ? "new-password" : "current-password";
};
$("authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("pass").value;
  $("authBtn").disabled = true;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) $("authMsg").textContent = "確認メールを送りました。メール内のリンクを開いたあと、ここに戻ってログインしてください。";
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const m = String(err.message || err);
    $("authMsg").textContent = /Invalid login/i.test(m) ? "メールアドレスかパスワードが違います。"
      : /not confirmed/i.test(m) ? "メールの確認がまだです。届いたメールのリンクを開いてください。"
      : /already registered/i.test(m) ? "このメールアドレスは登録済みです。ログインしてください。"
      : "うまくいきませんでした：" + m;
  }
  $("authBtn").disabled = false;
};
$("logout").onclick = async () => {
  if (pending.length && !confirmLogout()) return;
  await sb.auth.signOut();
};
function confirmLogout() {
  const b = $("logout");
  if (b.dataset.sure) return true;
  b.dataset.sure = "1"; b.textContent = "未送信あり・それでもログアウト";
  setTimeout(() => { delete b.dataset.sure; b.textContent = "ログアウト"; }, 4000);
  return false;
}
async function onSession(s) {
  const changed = (s?.user?.id) !== (session?.user?.id);
  session = s;
  if (!s) { entries = []; server = []; pending = []; ready = false; showApp(false); return; }
  $("who").textContent = s.user.email || "";
  showApp(true);
  if (changed) await load();
}

/* ---------- init ---------- */
renderParts(); renderEx(); renderDay();
if (!CFG.url || !CFG.key) {
  $("auth").classList.remove("hidden");
  $("authMsg").textContent = "config.js に Supabase の URL と公開キーが設定されていません。";
  $("authForm").classList.add("hidden"); $("authSwitch").classList.add("hidden");
} else {
  const { data } = await sb.auth.getSession();
  await onSession(data.session);
  sb.auth.onAuthStateChange((_ev, s) => { setTimeout(() => onSession(s), 0); });
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
