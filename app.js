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

const fromRow = r => ({ set_list: r.set_list || null, unilateral: !!r.unilateral, id: r.id, date: r.date, type: r.type, part: r.part, exercise: r.exercise, weight: r.weight,
  reps: r.reps, sets: r.sets, min: r.minutes, km: r.km, place: r.place, memo: r.memo, ts: r.created_at || "" });
const toRow = x => ({ set_list: x.set_list ?? null, unilateral: !!x.unilateral, id: x.id, date: x.date, type: x.type, part: x.part ?? null, exercise: x.exercise ?? null,
  weight: x.weight ?? null, reps: x.reps ?? null, sets: x.sets ?? null, minutes: x.min ?? null, km: x.km ?? null,
  place: x.place ?? null, memo: x.memo ?? null, created_at: x.ts });

function recompute() {
  const dels = new Set(pending.filter(p => p.op === "del").map(p => p.id));
  const upd = new Map(pending.filter(p => p.op === "upd").map(p => [p.row.id, p.row]));
  entries = server.filter(x => !dels.has(x.id)).map(x => upd.has(x.id) ? { ...upd.get(x.id), _pend: true } : x)
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
function updateEntry(id, patch) {
  const pi = pending.findIndex(p => p.op === "ins" && p.row.id === id);
  if (pi >= 0) pending[pi].row = { ...pending[pi].row, ...patch };
  else {
    const cur = entries.find(x => x.id === id); if (!cur) return;
    const row = { ...cur, ...patch }; delete row._pend;
    pending = pending.filter(p => !(p.op === "upd" && p.row.id === id));
    pending.push({ op: "upd", row });
  }
  recompute(); flush();
}
function removeEntry(id) {
  pending = pending.filter(p => !(p.op === "upd" && p.row.id === id));
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
      } else if (p.op === "upd") {
        const { error } = await sb.from(TABLE).upsert(toRow(p.row));
        if (error) throw error;
        server = server.map(x => x.id === p.row.id ? { ...p.row } : x);
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
    setStatus("サーバーから記録を読み込めませんでした。表示は前回保存した内容です。（" + (e?.code ? e.code + ": " : "") + (e?.message || e) + "）");
  }
}
window.addEventListener("online", () => { setStatus(""); flush(); load(); });
window.addEventListener("offline", () => setStatus("オフラインです。記録は端末に保存され、オンラインになると送信されます。"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session) flush(); });

const PARTS=["胸","背中","肩","腕","臀","脚","腹・体幹"];
const PRESETS={"胸":["チェストプレス","プッシュアップ","ペックフライ"],"背中":["ラットプルダウン","ケーブルプルオーバー","ニーリングワンハンドロウ","ローロウ","ワンハンドロウ","ロウイング","インバーテッドロウ"],"肩":["サイドレイズ","ショルダープレス","フェイスプル","リアデルト"],"腕":["フレンチプレス","トライセプスダウン","トライセプスキックバック"],"臀":["ブルガリアンスクワット","ヒップリフト","アブダクター","チューブステップ","ゴブレットスクワット"],"脚":["レッグプレス","アダクター","プローンレッグカール"],"腹・体幹":["アブベンチ","デッドバグ","プランク","リバースクランチ","レッグレイズ","サイドプランク・ローテーション"]};
const MONTHS=["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const today=new Date();
let entries=[],ready=false,saving=false;
const MENU=[
  {name:"レッグプレス",part:"脚",uni:true,max:60},
  {name:"ラットプルダウン",part:"背中"},
  {name:"チェストプレス",part:"胸"},
  {name:"ショルダープレス",part:"肩"},
  {name:"アブベンチ",part:"腹・体幹",bw:true},
  {name:"プランク",part:"腹・体幹",bw:true,sec:true,target:30}
];
const MSTEP=5,TARGET=15;
const menuSt={};
const st={type:"menu",part:"胸",ex:null,custom:false,place:"屋内",y:today.getFullYear(),m:today.getMonth()};

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
  $("fMenu").classList.toggle("hidden",st.type!=="menu");
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
function menuOn(){return MENU.filter(m=>menuSt[m.name])}
function updateSave(){const n=menuOn().length;
  $("save").textContent=st.type==="menu"&&n?`記録する（${n}種目）`:"記録する";
  $("save").disabled=!ready||saving||(st.type==="strength"&&!curEx())||(st.type==="menu"&&!n)}

/* --- per-set helpers --- */
function setsOf(x){if(Array.isArray(x.set_list)&&x.set_list.length)return x.set_list;
  return null}
function fmtSet(x){const sl=setsOf(x);
  if(!sl)return [x.weight?x.weight+"kg":"",(x.reps?x.reps+"回":"")+(x.sets?"×"+x.sets:"")].filter(Boolean).join(" ");
  const u=x.exercise==="プランク"?"秒":"";
  const grp=[];sl.forEach(s=>{const k=s.w==null?"自重":s.w+"kg";const g=grp[grp.length-1];
    if(g&&g.k===k)g.r.push(s.r);else grp.push({k,r:[s.r]})});
  const txt=grp.map(g=>{const rs=g.r.map(v=>v==null?"?":v+u);
    const same=rs.every(v=>v===rs[0]);return g.k+"×"+(same&&rs.length>1?rs[0]+"×"+rs.length:rs.join(","))}).join(" → ");
  return (x.unilateral?"片脚":"")+txt}
function nextPlan(m){const l=lastOf(m.name);const sl=l&&setsOf(l);
  const tgt=m.target||TARGET;
  if(!sl)return{w:null,n:3,label:l?"前回はセット別の記録なし":"はじめての記録",up:false,base:l};
  const ws=sl.map(s=>s.w).filter(v=>v!=null);const mx=ws.length?Math.max(...ws):null;
  const allTop=sl.length>=3&&sl.every(s=>(s.w??null)===mx&&s.r!=null&&s.r>=tgt);
  if(m.bw)return{w:null,n:Math.max(3,sl.length),label:allTop?(m.sec?"目標クリア。秒数を少し延ばしてもOK":"目標クリア。ゆっくり丁寧に"):`${tgt}${m.sec?"秒":"回"}×3を目指す`,up:allTop,base:l};
  if(mx==null)return{w:null,n:3,label:"重さを入れて記録",up:false,base:l};
  if(allTop){let nw=mx+MSTEP;let note="";if(m.max&&nw>m.max){nw=m.max;note="（マシン上限）"}
    return nw>mx?{w:nw,n:3,label:`上げどき → ${nw}kg`,up:true,base:l}:{w:mx,n:3,label:`上限${mx}kg。下ろすのに3秒かけて負荷アップ`,up:false,base:l}}
  return{w:mx,n:3,label:`${mx}kgで${tgt}回×3を目指す`,up:false,base:l}}
function renderMenu(){
  $("menuList").innerHTML=MENU.map(m=>{const p=nextPlan(m),on=menuSt[m.name];const l=p.base;
    const pv=l?`前回 ${l.date.slice(5).replace("-","/")}：${esc(fmtSet(l))}${l.memo?"（"+esc(l.memo)+"）":""}`:"まだ記録なし";
    let body="";
    if(on){body=`<div class="mb">${on.sets.map((s,i)=>`<div class="srow"><button class="no ${s.done?"dn":""}" data-a="done" data-m="${m.name}" data-i="${i}">${s.done?"✓":i+1}</button>
      ${m.bw?`<div class="stp" style="flex:0 0 74px;justify-content:center;align-items:center;color:var(--mu);font-size:13px">自重</div>`:
      `<div class="stp"><button data-a="w-" data-m="${m.name}" data-i="${i}">−</button><input inputmode="decimal" data-f="w" data-m="${m.name}" data-i="${i}" value="${s.w??""}" placeholder="kg"><span class="unit" style="align-self:center">kg</span><button data-a="w+" data-m="${m.name}" data-i="${i}">＋</button></div>`}
      <div class="stp"><button data-a="r-" data-m="${m.name}" data-i="${i}">−</button><input inputmode="numeric" data-f="r" data-m="${m.name}" data-i="${i}" value="${s.r??""}"><span class="unit" style="align-self:center">${m.sec?"秒":"回"}</span><button data-a="r+" data-m="${m.name}" data-i="${i}">＋</button></div>
      <button class="rm" data-a="rm" data-m="${m.name}" data-i="${i}">×</button></div>`).join("")}
      <button class="ad" data-a="add" data-m="${m.name}">＋ セットを追加</button>
      <input class="memo" data-f="memo" data-m="${m.name}" placeholder="メモ（フォーム・違和感など）" value="${esc(on.memo||"")}"></div>`}
    return `<div class="mc ${on?"on":""}"><button class="mch" data-a="tg" data-m="${m.name}"><span class="ck">${on?"✓":""}</span><span style="flex:1;min-width:0">
      <div class="nm">${m.name}<small>${m.part}${m.uni?"・片脚":""}</small></div><div class="pv">${pv}</div><div class="nx ${p.up?"up":""}">次回の目安：${esc(p.label)}</div></span></button>${body}</div>`}).join("");
  updateSave()}
$("menuList").addEventListener("click",e=>{const b=e.target.closest("[data-a]");if(!b)return;
  const m=MENU.find(x=>x.name===b.dataset.m),a=b.dataset.a,i=+b.dataset.i;
  if(a==="tg"){if(menuSt[m.name])delete menuSt[m.name];else{const p=nextPlan(m);const tgt=m.target||TARGET;
      menuSt[m.name]={sets:Array.from({length:p.n},()=>({w:m.bw?null:p.w,r:tgt})),memo:""}}
    renderMenu();return}
  const o=menuSt[m.name];if(!o)return;
  if(a==="done"){const s=o.sets[i];s.done=!s.done;renderMenu();
    if(s.done){const left=o.sets.some(x=>!x.done)||MENU.some(x=>menuSt[x.name]&&menuSt[x.name].sets.some(y=>!y.done));if(left)startTimer()}return}
  if(a==="add"){const last=o.sets[o.sets.length-1]||{w:null,r:m.target||TARGET};o.sets.push({w:last.w,r:last.r})}
  else if(a==="rm"){o.sets.splice(i,1);if(!o.sets.length)delete menuSt[m.name]}
  else{const s=o.sets[i];const d=a.endsWith("+")?1:-1;
    if(a[0]==="w"){s.w=Math.max(0,(s.w||0)+d*(s.w!=null&&s.w<5?1:MSTEP))||null}
    else{s.r=Math.max(0,(s.r||0)+d*(m.sec?5:1))}
    if(navigator.vibrate)try{navigator.vibrate(8)}catch(_){}}
  renderMenu()});
$("menuList").addEventListener("input",e=>{const t=e.target;if(!t.dataset.f)return;const o=menuSt[t.dataset.m];if(!o)return;
  if(t.dataset.f==="memo"){o.memo=t.value;return}
  const v=parseFloat(t.value);o.sets[+t.dataset.i][t.dataset.f]=isNaN(v)?null:v});
function saveMenu(date){const list=menuOn();
  list.forEach(m=>{const o=menuSt[m.name];const sl=o.sets.map(s=>({w:m.bw?null:(s.w??null),r:s.r??null}));stopTimer();
    const ws=sl.map(s=>s.w).filter(v=>v!=null);
    addEntry({type:"strength",date,part:m.part,exercise:m.name,unilateral:!!m.uni,set_list:sl,
      weight:ws.length?Math.max(...ws):null,reps:sl.map(s=>s.r??"?").join(","),sets:sl.length,memo:(o.memo||"").trim()||null});
    delete menuSt[m.name]});
  return list.length}

$("save").onclick=async()=>{if(!ready)return;let data;
  const date=$("date").value||ymd(today);
  if(st.type==="menu"){saving=true;updateSave();const n=saveMenu(date);saving=false;
    toast(`${n}種目を記録しました`+(navigator.onLine?"":"（オンラインになったら送信）"));renderMenu();return}
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
  $("dayList").innerHTML=list.length?list.map(x=>`<div class="item"><div class="t"><div>${x.type==="run"?"🏃 ラン":"🏋️ "+esc(x.exercise)}${x._pend?'<span class="pend">未送信</span>':""}</div><div>${x.type==="run"?`${x.min}分・${x.km}km・${esc(x.place)}${x.memo?"　"+esc(x.memo):""}`:esc(x.part)+"　"+esc(fmtSet(x))+(x.memo?"　"+esc(x.memo):"")}</div></div><button class="del" data-id="${x.id}">編集</button></div>`).join(""):`<div class="empty">まだ記録はありません</div>`}
$("dayList").onclick=e=>{const it=e.target.closest(".item");if(!it)return;const b=it.querySelector(".del");if(b)openEdit(b.dataset.id)};

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
    h+=`<div class="${s?"act":""}" data-day="${k}"><div class="d">${d}</div><div class="ic">${s?(s.has("strength")?"🏋️":"")+(s.has("run")?"🏃":""):""}</div></div>`}
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
  entries.slice().sort((a,b)=>(a.date+a.ts).localeCompare(b.date+b.ts)).forEach(x=>rows.push(x.type==="run"?[x.date,"ラン","","","","","",x.min,x.km,x.place,x.memo]:[x.date,"筋トレ",x.part,x.exercise,x.weight??"",x.reps,x.sets,"","","",[fmtSet(x),x.memo].filter(Boolean).join(" / ")]));
  return rows.map(r=>r.map(v=>{v=String(v??"");return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(",")).join("\n")}
$("csvDl").onclick=()=>{const blob=new Blob(["\ufeff"+buildCsv()],{type:"text/csv"});const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);a.download="workout-log-"+ymd(new Date())+".csv";document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)};
$("csv").onclick=async()=>{const csv=buildCsv();
  try{await navigator.clipboard.writeText(csv);toast(`${entries.length}件をコピーしました`)}
  catch(_){const t=$("csvBox");t.value=csv;t.classList.remove("hidden");t.select();toast("下の欄から全選択してコピーしてください")}};

function renderAll(){renderMenu();renderEx();renderDay();if(!$("v-month").classList.contains("hidden"))renderMonth()}


/* ---------- calendar -> day ---------- */
$("monthBody").addEventListener("click",e=>{const c=e.target.closest("[data-day]");if(!c)return;
  $("date").value=c.dataset.day;syncQuick();renderDay();location.hash="log";
  setTimeout(()=>$("dayCap").scrollIntoView({behavior:"smooth",block:"start"}),60)});

/* ---------- edit sheet ---------- */
let ed=null;
function openEdit(id){const x=entries.find(e=>e.id===id);if(!x)return;
  ed={id,type:x.type,date:x.date,memo:x.memo||"",exercise:x.exercise,part:x.part,unilateral:!!x.unilateral,
    min:x.min,km:x.km,place:x.place||"屋内",
    sets:x.type==="strength"?(setsOf(x)?setsOf(x).map(s=>({w:s.w,r:s.r})):Array.from({length:x.sets||1},()=>({w:x.weight??null,r:parseInt(x.reps,10)||null}))):[],
    sec:x.exercise==="プランク",sure:false};
  renderEdit();$("sheet").classList.remove("hidden");document.body.style.overflow="hidden"}
function closeEdit(){ed=null;$("sheet").classList.add("hidden");document.body.style.overflow=""}
function renderEdit(){if(!ed)return;const u=ed.sec?"秒":"回";
  let h=`<div class="shh"><b>${ed.type==="run"?"🏃 ラン":"🏋️ "+esc(ed.exercise)}</b><button class="x" data-e="close">✕</button></div>
  <small class="lbl">日付</small><input type="date" data-ef="date" value="${ed.date}">`;
  if(ed.type==="strength"){
    h+=`<small class="lbl">セット${ed.unilateral?"（片脚）":""}</small>`+ed.sets.map((s,i)=>`<div class="srow"><span class="no" style="border:none">${i+1}</span>
      <div class="stp"><button data-e="w-" data-i="${i}">−</button><input inputmode="decimal" data-ef="w" data-i="${i}" value="${s.w??""}" placeholder="自重"><span class="unit" style="align-self:center">kg</span><button data-e="w+" data-i="${i}">＋</button></div>
      <div class="stp"><button data-e="r-" data-i="${i}">−</button><input inputmode="numeric" data-ef="r" data-i="${i}" value="${s.r??""}"><span class="unit" style="align-self:center">${u}</span><button data-e="r+" data-i="${i}">＋</button></div>
      <button class="rm" data-e="rm" data-i="${i}">×</button></div>`).join("")+`<button class="ad" data-e="add">＋ セットを追加</button>`;
  }else{
    h+=`<div class="row" style="margin-top:6px"><div><small class="lbl">時間（分）</small><input inputmode="decimal" data-ef="min" value="${ed.min??""}"></div><div><small class="lbl">距離（km）</small><input inputmode="decimal" data-ef="km" value="${ed.km??""}"></div></div>
    <small class="lbl">場所</small><div class="seg">${["屋内","屋外"].map(p=>`<button class="chip ${ed.place===p?"on":""}" data-e="place" data-v="${p}">${p}</button>`).join("")}</div>`;
  }
  h+=`<small class="lbl">メモ</small><input data-ef="memo" value="${esc(ed.memo)}" placeholder="${ed.type==="run"?"内容":"フォーム・違和感など"}">
  <button class="btn" data-e="save">保存する</button>
  <button class="btn ghost ${ed.sure?"danger":""}" data-e="del" style="margin-top:10px">${ed.sure?"本当に削除する":"この記録を削除"}</button>`;
  $("sheetBody").innerHTML=h}
$("sheet").addEventListener("click",e=>{if(e.target.id==="sheet"){closeEdit();return}
  const b=e.target.closest("[data-e]");if(!b||!ed)return;const a=b.dataset.e,i=+b.dataset.i;
  if(a==="close"){closeEdit();return}
  if(a==="place"){ed.place=b.dataset.v}
  else if(a==="add"){const l=ed.sets[ed.sets.length-1]||{w:null,r:null};ed.sets.push({w:l.w,r:l.r})}
  else if(a==="rm"){ed.sets.splice(i,1)}
  else if(a==="w-"||a==="w+"||a==="r-"||a==="r+"){const s=ed.sets[i],d=a.endsWith("+")?1:-1;
    if(a[0]==="w")s.w=Math.max(0,(s.w||0)+d*(s.w!=null&&s.w<5?1:MSTEP))||null;else s.r=Math.max(0,(s.r||0)+d*(ed.sec?5:1))}
  else if(a==="del"){if(!ed.sure){ed.sure=true;renderEdit();return}removeEntry(ed.id);closeEdit();toast("削除しました");return}
  else if(a==="save"){let patch={date:ed.date||ymd(today),memo:ed.memo.trim()||null};
    if(ed.type==="strength"){if(!ed.sets.length){toast("セットが0です。削除する場合は下のボタンから");return}
      const sl=ed.sets.map(s=>({w:s.w??null,r:s.r??null}));const ws=sl.map(s=>s.w).filter(v=>v!=null);
      Object.assign(patch,{set_list:sl,sets:sl.length,weight:ws.length?Math.max(...ws):null,reps:sl.map(s=>s.r??"?").join(",")});
    }else{Object.assign(patch,{min:parseFloat(ed.min)||0,km:parseFloat(ed.km)||0,place:ed.place})}
    updateEntry(ed.id,patch);closeEdit();toast("更新しました");return}
  renderEdit()});
$("sheet").addEventListener("input",e=>{const t=e.target,f=t.dataset.ef;if(!f||!ed)return;
  if(f==="w"||f==="r"){const v=parseFloat(t.value);ed.sets[+t.dataset.i][f]=isNaN(v)?null:v}else ed[f]=t.value});

/* ---------- rest timer ---------- */
let tEnd=0,tTick=null,tLen=90,tDone=false,actx=null,wlock=null;
try{tLen=+localStorage.getItem("wl_rest")||90}catch(_){}
function unlockAudio(){try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();if(actx.state==="suspended")actx.resume()}catch(_){}}
function beep(){if(!actx)return;[0,0.35,0.7].forEach(t=>{const o=actx.createOscillator(),g=actx.createGain();o.frequency.value=880;o.connect(g);g.connect(actx.destination);
  const at=actx.currentTime+t;g.gain.setValueAtTime(0.0001,at);g.gain.exponentialRampToValueAtTime(0.4,at+0.02);g.gain.exponentialRampToValueAtTime(0.0001,at+0.25);o.start(at);o.stop(at+0.3)})}
async function keepAwake(on){try{if(on&&navigator.wakeLock&&!wlock){wlock=await navigator.wakeLock.request("screen");wlock.addEventListener("release",()=>wlock=null)}
  if(!on&&wlock){await wlock.release();wlock=null}}catch(_){}}
function fmtT(sec){sec=Math.max(0,Math.ceil(sec));return Math.floor(sec/60)+":"+pad(sec%60)}
function renderTimer(){const el=$("timer");if(!tEnd&&!tDone){el.classList.add("hidden");return}
  el.classList.remove("hidden");const left=(tEnd-Date.now())/1000;
  el.classList.toggle("done",tDone);
  $("tTime").textContent=tDone?"0:00":fmtT(left);$("tLabel").textContent=tDone?"休憩終了！次のセットへ":"休憩中";
  $("tBar").style.width=tDone?"100%":Math.min(100,(1-left/tLen)*100)+"%"}
function startTimer(len){unlockAudio();if(len)tLen=len;tEnd=Date.now()+tLen*1000;tDone=false;keepAwake(true);
  clearInterval(tTick);tTick=setInterval(tick,250);renderTimer();renderRestChips()}
function tick(){if(!tEnd)return;if(Date.now()>=tEnd){tEnd=0;tDone=true;clearInterval(tTick);beep();
    if(navigator.vibrate)try{navigator.vibrate([300,150,300])}catch(_){}
    setTimeout(()=>{if(tDone){tDone=false;renderTimer();keepAwake(false)}},15000)}
  renderTimer()}
function stopTimer(){tEnd=0;tDone=false;clearInterval(tTick);keepAwake(false);renderTimer()}
function renderRestChips(){$("restSeg").innerHTML=[60,90,120].map(v=>`<button class="chip ${v===tLen?"on":""}" data-r="${v}">${v}秒</button>`).join("")+`<button class="chip" data-r="go">⏱ スタート</button>`}
$("restSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.r==="go"){startTimer();return}
  tLen=+b.dataset.r;try{localStorage.setItem("wl_rest",tLen)}catch(_){}
  if(tEnd)startTimer(tLen);else renderRestChips()};
$("timer").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.t==="stop"){stopTimer();return}
  if(tDone){startTimer();return}
  tEnd+=(+b.dataset.t)*1000;tLen=Math.max(10,tLen+(+b.dataset.t));renderTimer()};
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){tick();if(tEnd)keepAwake(true)}});
renderRestChips();

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
renderParts(); renderMenu(); renderEx(); renderDay();
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
