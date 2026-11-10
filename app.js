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

const fromRow = r => ({ started_at: r.started_at || null, set_list: r.set_list || null, unilateral: !!r.unilateral, id: r.id, date: r.date, type: r.type, part: r.part, exercise: r.exercise, weight: r.weight,
  reps: r.reps, sets: r.sets, min: r.minutes, km: r.km, place: r.place, memo: r.memo, ts: r.created_at || "" });
const toRow = x => ({ started_at: x.started_at ?? null, set_list: x.set_list ?? null, unilateral: !!x.unilateral, id: x.id, date: x.date, type: x.type, part: x.part ?? null, exercise: x.exercise ?? null,
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
  const row = { started_at: sessStart(data.date), ...data, id: uuid(), ts: new Date().toISOString() };
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

const PARTS=["肩","胸","背中","腕","腹・体幹","臀","脚"];
const PRESETS={"胸":["チェストプレス","プッシュアップ","ペックフライ"],"背中":["ラットプルダウン","ケーブルプルオーバー","ニーリングワンハンドロウ","ローロウ","ワンハンドロウ","ロウイング","インバーテッドロウ"],"肩":["サイドレイズ","ショルダープレス","フェイスプル","リアデルト"],"腕":["フレンチプレス","トライセプスダウン","トライセプスキックバック"],"臀":["ブルガリアンスクワット","ヒップリフト","アブダクター","チューブステップ","ゴブレットスクワット"],"脚":["レッグプレス","アダクター","プローンレッグカール"],"腹・体幹":["アブベンチ","デッドバグ","プランク","リバースクランチ","レッグレイズ","サイドプランク・ローテーション"]};
const MONTHS=["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const ymd=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const today=new Date();
let entries=[],ready=false,saving=false;
const MENUS={machine:[
  {name:"ショルダープレス",part:"肩"},
  {name:"チェストプレス",part:"胸"},
  {name:"ラットプルダウン",part:"背中"},
  {name:"アブベンチ",part:"腹・体幹",bw:true},
  {name:"レッグプレス",part:"脚",uni:true,max:60},
  {name:"プランク",part:"腹・体幹",bw:true,sec:true,target:30}
],db:[
  {name:"サイドレイズ",part:"肩",step:1,uni:"片手"},
  {name:"ワンハンドロウ",part:"背中",step:1,uni:"片手"},
  {name:"ダンベルカール",part:"腕",step:1,uni:"片手"},
  {name:"フレンチプレス",part:"腕",step:1}
]};
const TIPS={"ショルダープレス": ["グリップが肩の高さかやや下に来るようにシートを調整", "腰と背もたれの間にすき間ができたら、そのセットは中止", "肩を下げたまま押し、肘は伸ばしきらない"], "チェストプレス": ["肩甲骨を寄せて胸を張ったまま押す", "グリップは胸の中央の高さ", "戻すときは2〜3秒かけてゆっくり"], "ラットプルダウン": ["セット前に肩甲骨を下げる動きを10回", "手は軽く握り、肘を腰のポケットに下ろすイメージ", "一番下で1秒止めて、脇の下に効いていればOK"], "アブベンチ": ["足をパッドに引っかけない", "肩甲骨が浮くところ（30〜45度）まで", "腰をパッドに押しつけたまま、息を吐きながら丸める"], "レッグプレス": ["膝が内側に入らないように", "膝は伸ばしきらない", "上限に達したら、下ろすのに3秒かける"], "プランク": ["頭からかかとまで一直線", "お尻が下がって腰が反るのはNG", "呼吸は止めない"], "サイドレイズ": ["肘を軽く曲げ、肩の高さまで", "肩をすくめない・反動を使わない", "下ろすのに2〜3秒"], "ワンハンドロウ": ["背中をまっすぐ、床と平行に近く", "肘を腰のポケットに向かって引く", "体をひねらない・腰を丸めない"], "ダンベルカール": ["肘を体の横に固定", "体を反らせて反動を使わない", "上で一瞬締めて、ゆっくり下ろす"], "フレンチプレス": ["背もたれのある椅子に座って", "肘を天井に向け、外に開かない", "二の腕の裏が伸びる感覚を確認"]};
const ALLM=[...MENUS.machine,...MENUS.db];
const isMenu=t=>t==="machine"||t==="db";
const curMenu=()=>MENUS[st.type]||[];
const findM=n=>ALLM.find(x=>x.name===n);
const uniLabel=m=>m&&m.uni?(m.uni===true?"片脚":m.uni):"";
const stepOf=(n,w)=>{const m=findM(n);const st_=m&&m.step?m.step:(n&&/ダンベル|レイズ|カール|フレンチ|キックバック|ゴブレット|ブルガリアン|ワンハンド/.test(n)?1:5);return w!=null&&w<5&&st_>1?1:st_};
const MSTEP=5,TARGET=15;
const RIR=[{v:3,e:"😌",l:"余裕",d:"あと3回以上"},{v:1,e:"😤",l:"ギリギリ",d:"あと1〜2回"},{v:0,e:"🔥",l:"限界",d:"あと0回"}];
const rirOf=v=>RIR.find(x=>x.v===v);
const RIR_REST={3:90,1:120,0:150};
function rirPicker(attr,i,cur){return `<div class="rir">${RIR.map(x=>`<button ${attr}="rir" data-i="${i}" data-v="${x.v}" class="${cur===x.v?"on":""}"><span>${x.e} ${x.l}</span><small>${x.d}</small></button>`).join("")}</div>`}
function rirText(x){const sl=setsOf(x);if(!sl||!sl.some(s=>s.rir!=null))return"";return sl.map(s=>s.rir!=null?rirOf(s.rir).e:"・").join("")}
function rirWords(x){const sl=setsOf(x);if(!sl||!sl.some(s=>s.rir!=null))return"";return "きつさ："+sl.map((s,i)=>`${i+1}セット目${s.rir!=null?rirOf(s.rir).l+"（"+rirOf(s.rir).d+"）":"未入力"}`).join("、")}
/* --- session timing --- */
function sessGet(){try{return JSON.parse(localStorage.getItem("wl_sess")||"null")}catch(_){return null}}
function sessMark(){const d=ymd(new Date());const s=sessGet();
  if(s&&s.d===d){if(s.end){delete s.end;try{localStorage.setItem("wl_sess",JSON.stringify(s))}catch(_){}renderElapsed()}return}
  try{localStorage.setItem("wl_sess",JSON.stringify({d,t:new Date().toISOString()}))}catch(_){}renderElapsed()}
function sessStart(date){const s=sessGet();return s&&s.d===date?s.t:null}
function renderElapsed(){const el=document.getElementById("elapsed");if(!el)return;const s=sessGet();
  if(!s||s.d!==ymd(new Date())){el.classList.add("hidden");return}
  const sec=Math.max(0,Math.floor(((s.end?new Date(s.end):Date.now())-new Date(s.t))/1000));
  const m=Math.floor(sec/60),ss=sec%60;
  el.className="elapsed"+(s.end?" fin":"");
  el.innerHTML=`<div class="et"><span>${s.end?"今日のトレーニング":"トレーニング中"}</span><button id="sessReset">リセット</button></div>
    <div class="em"><b>${m}<small>:${pad(ss)}</small></b><span>${s.end?"おつかれさまでした":""}</span></div>`}
setInterval(()=>{const s=sessGet();if(s&&!s.end)renderElapsed()},1000);
function dayMinutes(list){const st=list.map(x=>x.started_at).filter(Boolean).map(v=>+new Date(v));
  const en=list.filter(x=>x.type==="strength").map(x=>+new Date(x.ts)).filter(v=>!isNaN(v));
  if(!st.length||!en.length)return null;const m=Math.round((Math.max(...en)-Math.min(...st))/60000);return m>0&&m<240?m:null}
const menuSt={};
const st={type:"machine",part:"胸",ex:null,custom:false,place:"屋内",y:today.getFullYear(),m:today.getMonth()};

function toast(t){const e=$("toast");e.textContent=t;e.classList.add("on");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("on"),1800)}
function setStatus(t){const s=$("status");if(t){s.textContent=t;s.classList.remove("hidden")}else s.classList.add("hidden")}

/* ---------- routing ---------- */
function route(){if(!session)return;setTimeout(renderElapsed,0);const v=location.hash==="#log"?"log":location.hash==="#settings"?"settings":"month";
  $("v-settings").classList.toggle("hidden",v!=="settings");
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("on",b.dataset.v===v));
  $("v-log").classList.toggle("hidden",v!=="log");$("saveBar").classList.toggle("hidden",v!=="log");$("v-month").classList.toggle("hidden",v!=="month");
  if(v==="month")renderMonth();window.scrollTo(0,0)}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{location.hash=b.dataset.v});
window.addEventListener("hashchange",route);
$("gear").onclick=()=>{location.hash="settings"};
$("setBack").onclick=()=>{location.hash="month"};

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
  $("fMenu").classList.toggle("hidden",!isMenu(st.type));if(isMenu(st.type))renderMenu();
  $("fStrength").classList.toggle("hidden",st.type!=="strength");$("fRun").classList.toggle("hidden",st.type!=="run");updateSave()};
function runPace(){const mn=parseFloat($("rmin").value),km=parseFloat($("rkm").value);
  $("rPace").textContent=mn>0&&km>0?`ペース ${Math.floor(mn/km)}'${pad(Math.round((mn/km%1)*60))}"/km・時速${(km/(mn/60)).toFixed(1)}km`:""}
document.querySelectorAll("[data-rq]").forEach(b=>b.onclick=()=>{const t=b.dataset.rq==="min"?$("rmin"):$("rkm");t.value=b.dataset.v;
  [...b.parentNode.children].forEach(x=>x.classList.toggle("on",x===b));runPace()});
document.querySelectorAll("[data-rs]").forEach(b=>b.onclick=()=>{const isMin=b.dataset.rs.startsWith("min");const t=isMin?$("rmin"):$("rkm");
  let v=parseFloat(t.value)||0;v=Math.max(0,Math.round((v+(+b.dataset.d)*(isMin?1:0.1))*10)/10);t.value=v||"";
  document.querySelectorAll(`[data-rq="${isMin?"min":"km"}"]`).forEach(x=>x.classList.toggle("on",+x.dataset.v===v));runPace()});
$("rmin").oninput=$("rkm").oninput=runPace;
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
function menuOn(){return curMenu().filter(m=>menuSt[m.name])}
function updateSave(){const n=menuOn().length;
  $("save").textContent=isMenu(st.type)&&n?`記録する（${n}種目）`:"記録する";
  $("save").disabled=!ready||saving||(st.type==="strength"&&!curEx())||(isMenu(st.type)&&!n)}

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
  return (x.unilateral?(uniLabel(findM(x.exercise))||"片脚"):"")+txt}
function nextPlan(m){const l=lastOf(m.name);const sl=l&&setsOf(l);
  const tgt=m.target||TARGET;
  if(!sl)return{w:null,n:3,label:l?"前回はセット別の記録なし":"はじめての記録",up:false,base:l};
  const ws=sl.map(s=>s.w).filter(v=>v!=null);const mx=ws.length?Math.max(...ws):null;
  const allTop=sl.length>=3&&sl.every(s=>(s.w??null)===mx&&s.r!=null&&s.r>=tgt);
  if(m.bw)return{w:null,n:Math.max(3,sl.length),label:allTop?(m.sec?"目標クリア。秒数を少し延ばしてもOK":"目標クリア。ゆっくり丁寧に"):`${tgt}${m.sec?"秒":"回"}×3を目指す`,up:allTop,base:l};
  if(mx==null)return{w:null,n:3,label:"重さを入れて記録",up:false,base:l};
  const allEasy=sl.length>=3&&sl.every(s=>s.rir===3);
  if(allTop){let nw=mx+(m.step||MSTEP);let note="";if(m.max&&nw>m.max){nw=m.max;note="（マシン上限）"}
    return nw>mx?{w:nw,n:3,label:`上げどき → ${nw}kg${allEasy?"（前回は全セット余裕）":""}`,up:true,base:l}:{w:mx,n:3,label:`上限${mx}kg。下ろすのに3秒かけて負荷アップ`,up:false,base:l}}
  const anyMax=sl.some(s=>s.rir===0&&(s.r??0)<tgt);
  return{w:mx,n:3,label:`${mx}kgで${tgt}回×3を目指す${anyMax?"（前回は限界まで出し切れています）":""}`,up:false,base:l}}
function tipsFor(m,p){const out=[];const l=lastOf(m.name);const sl=l&&setsOf(l);
  if(l&&l.memo)out.push({k:"memo",t:`📝 前回のメモ：${l.memo}`});
  if(p.up)out.push({k:"up",t:"⬆ 今日は上げる日。上げた直後は10〜12回で終わっても正常、フォームが崩れなければ成功"});
  if(sl&&sl.length>=2&&!m.bw){const ws=sl.map(x=>x.w??0),mx=Math.max(...ws);
    if(ws[ws.length-1]<mx)out.push({k:"warn",t:`💪 前回は最後のセットだけ軽くしていました。今日は${sl.length}セットとも${mx}kgで粘る（10〜12回でOK）`})}
  const tp=TIPS[m.name];if(tp&&tp.length){const n=entries.filter(x=>x.exercise===m.name).length;
    let always=false;try{always=localStorage.getItem("wl_tips_always")==="1"}catch(_){}
    const gap=l?Math.round((new Date(ymd(new Date())+"T00:00")-new Date(l.date+"T00:00"))/86400000):0;
    const worry=l&&l.memo&&/痛|違和感|反る|反っ|しびれ|痺れ|張り|ズキ|不安/.test(l.memo);
    const why=always||n<10?"":p.up?"（重さを上げる日なので）":gap>=21?`（${gap}日ぶりなので）`:worry?"（前回のメモが気になるので）":null;
    if(why!==null)out.push({k:"std",t:"✓ "+tp[n%tp.length]+why})}
  return out}
function renderMenu(){
  $("menuHint").textContent=st.type==="db"?"重さはダンベル1個あたりで入力。":"";
  $("menuList").innerHTML=curMenu().map(m=>{const p=nextPlan(m),on=menuSt[m.name];const l=p.base;
    const pv=l?`前回 ${l.date.slice(5).replace("-","/")}：${esc(fmtSet(l))}${rirText(l)?" "+rirText(l):""}${l.memo?"（"+esc(l.memo)+"）":""}`:"まだ記録なし";
    let body="";
    if(on){const tl=tipsFor(m,p);body=`<div class="mb">${tl.length?`<ul class="tips">${tl.map(t=>`<li class="${t.k}">${esc(t.t)}</li>`).join("")}</ul>`:""}${on.sets.map((s,i)=>`<div class="srow"><button class="no ${s.done?"dn":""}" data-a="done" data-m="${m.name}" data-i="${i}">${s.done?(s.rir!=null?rirOf(s.rir).e:"✓"):i+1}</button>
      ${m.bw?`<div class="stp" style="flex:0 0 74px;justify-content:center;align-items:center;color:var(--mu);font-size:13px">自重</div>`:
      `<div class="stp"><button data-a="w-" data-m="${m.name}" data-i="${i}">−</button><input inputmode="decimal" data-f="w" data-m="${m.name}" data-i="${i}" value="${s.w??""}" placeholder="kg"><span class="unit" style="align-self:center">kg</span><button data-a="w+" data-m="${m.name}" data-i="${i}">＋</button></div>`}
      <div class="stp"><button data-a="r-" data-m="${m.name}" data-i="${i}">−</button><input inputmode="numeric" data-f="r" data-m="${m.name}" data-i="${i}" value="${s.r??""}"><span class="unit" style="align-self:center">${m.sec?"秒":"回"}</span><button data-a="r+" data-m="${m.name}" data-i="${i}">＋</button></div>
      <button class="rm" data-a="rm" data-m="${m.name}" data-i="${i}">×</button></div>${s.done?rirPicker(`data-m="${m.name}" data-a`,i,s.rir):""}`).join("")}
      ${p.w!=null&&on.sets.some(x=>!x.done&&x.w!==p.w)?`<button class="ad fit" data-a="fit" data-m="${m.name}">残りのセットを目標の ${p.w}kg にそろえる</button>`:""}
      <button class="ad" data-a="add" data-m="${m.name}">＋ セットを追加</button>
      <input class="memo" data-f="memo" data-m="${m.name}" placeholder="メモ（フォーム・違和感など）" value="${esc(on.memo||"")}"></div>`}
    return `<div class="mc ${on?"on":""}"><button class="mch" data-a="tg" data-m="${m.name}"><span class="ck">${on?"✓":""}</span><span style="flex:1;min-width:0">
      <div class="nm">${m.name}<small>${m.part}${m.uni?"・"+uniLabel(m):""}</small></div><div class="pv">${pv}</div><div class="nx ${p.up?"up":""}">次回の目安：${esc(p.label)}</div></span>${p.w!=null?`<span class="tgt ${p.up?"up":""}"><small>目標</small><b>${p.w}</b><i>kg</i>${p.up?`<em>▲UP</em>`:""}</span>`:""}</button>${body}</div>`}).join("");
  updateSave()}
$("menuList").addEventListener("click",e=>{const b=e.target.closest("[data-a]");if(!b)return;
  const m=findM(b.dataset.m),a=b.dataset.a,i=+b.dataset.i;
  if(a==="tg"){if(menuSt[m.name])delete menuSt[m.name];else{sessMark();const tgt=m.target||TARGET;
      const l=lastOf(m.name);const sl=l&&setsOf(l);
      const n=Math.max(3,sl?sl.length:0);
      const lw=i=>{if(m.bw)return null;if(sl){const s=sl[Math.min(i,sl.length-1)];return s.w??null}return l?(l.weight??null):null};
      menuSt[m.name]={sets:Array.from({length:n},(_,i)=>({w:lw(i),r:tgt})),memo:""}}
    renderMenu();return}
  const o=menuSt[m.name];if(!o)return;
  if(a==="rir"){const s=o.sets[i];const v=+b.dataset.v;s.rir=s.rir===v?null:v;renderMenu();
    if(s.rir!=null&&tEnd){const len=RIR_REST[s.rir];tCur=len;tNote=`${rirOf(s.rir).l}→${len}秒`;tEnd=tStart+len*1000;renderTimer()}
    return}
  if(a==="done"){sessMark();const s=o.sets[i];s.done=!s.done;if(!s.done)delete s.rir;renderMenu();
    if(s.done){const left=o.sets.some(x=>!x.done)||curMenu().some(x=>menuSt[x.name]&&menuSt[x.name].sets.some(y=>!y.done));if(left)startTimer()}return}
  if(a==="fit"){const p=nextPlan(m);o.sets.forEach(x=>{if(!x.done)x.w=p.w});renderMenu();return}
  if(a==="add"){const last=o.sets[o.sets.length-1]||{w:null,r:m.target||TARGET};o.sets.push({w:last.w,r:last.r})}
  else if(a==="rm"){o.sets.splice(i,1);if(!o.sets.length)delete menuSt[m.name]}
  else{const s=o.sets[i];const d=a.endsWith("+")?1:-1;
    if(a[0]==="w"){const old=s.w;s.w=Math.max(0,(s.w||0)+d*stepOf(m.name,s.w))||null;
      for(let k=i+1;k<o.sets.length;k++){if(o.sets[k].w===old&&!o.sets[k].done)o.sets[k].w=s.w;else break}}
    else{s.r=Math.max(0,(s.r||0)+d*(m.sec?5:1))}
    if(navigator.vibrate)try{navigator.vibrate(8)}catch(_){}}
  renderMenu()});
$("menuList").addEventListener("input",e=>{const t=e.target;if(!t.dataset.f)return;const o=menuSt[t.dataset.m];if(!o)return;
  if(t.dataset.f==="memo"){o.memo=t.value;return}
  const v=parseFloat(t.value),i=+t.dataset.i,f=t.dataset.f,old=o.sets[i][f];o.sets[i][f]=isNaN(v)?null:v;
  if(f==="w")for(let k=i+1;k<o.sets.length;k++){if(o.sets[k].w===old&&!o.sets[k].done){o.sets[k].w=o.sets[i].w;
    const el=document.querySelector(`#menuList input[data-f="w"][data-m="${t.dataset.m}"][data-i="${k}"]`);if(el)el.value=o.sets[i].w??""}else break}});
function saveMenu(date){const list=menuOn();
  list.forEach(m=>{const o=menuSt[m.name];const sl=o.sets.map(s=>{const z={w:m.bw?null:(s.w??null),r:s.r??null};if(s.rir!=null)z.rir=s.rir;return z});stopTimer();
    const ws=sl.map(s=>s.w).filter(v=>v!=null);
    addEntry({type:"strength",date,part:m.part,exercise:m.name,unilateral:!!m.uni,set_list:sl,
      weight:ws.length?Math.max(...ws):null,reps:sl.map(s=>s.r??"?").join(","),sets:sl.length,memo:(o.memo||"").trim()||null});
    delete menuSt[m.name]});
  if(!Object.keys(menuSt).length){const s_=sessGet();if(s_){s_.end=new Date().toISOString();try{localStorage.setItem("wl_sess",JSON.stringify(s_))}catch(_){}renderElapsed()}}
  return list.length}

$("save").onclick=async()=>{if(!ready)return;let data;
  const date=$("date").value||ymd(today);
  if(isMenu(st.type)){saving=true;updateSave();const n=saveMenu(date);saving=false;
    toast(`${n}種目を記録しました`+(navigator.onLine?"":"（オンラインになったら送信）"));renderMenu();return}
  if(st.type==="strength"){const ex=curEx();if(!ex)return;
    const w=parseFloat($("w").value);const s=parseInt($("sets").value,10);
    data={type:"strength",date,part:st.part,exercise:ex,weight:isNaN(w)?null:w,reps:$("reps").value.trim(),sets:isNaN(s)?1:s};
  }else{const mn=parseFloat($("rmin").value),km=parseFloat($("rkm").value);
    if(isNaN(mn)&&isNaN(km)){toast("時間か距離を入れてください");return}
    data={type:"run",date,min:isNaN(mn)?0:mn,km:isNaN(km)?0:km,place:st.place,memo:$("rmemo").value.trim()};}
  saving=true;updateSave();
  try{addEntry(data);toast(navigator.onLine?"記録しました":"記録しました（オンラインになったら送信）");
    if(st.type==="run"){$("rmin").value="";$("rkm").value="";$("rmemo").value="";runPace();document.querySelectorAll("[data-rq]").forEach(x=>x.classList.remove("on"))}
    if(st.custom){st.custom=false;st.ex=data.exercise;$("exCustom").value=""}
  }catch(e){toast("保存できませんでした。もう一度お試しください")}
  saving=false;updateSave();renderEx()};

function renderDay(){const d=$("date").value;const list=entries.filter(x=>x.date===d).sort((a,b)=>a.ts.localeCompare(b.ts));
  const dm=dayMinutes(list);
  $("dayCap").textContent=`${d.slice(5).replace("-","/")} の記録`+(dm?`　⏱ ${dm}分`:"");
  $("dayList").innerHTML=list.length?list.map(x=>`<div class="item"><div class="t"><div>${x.type==="run"?"🏃 ラン":"🏋️ "+esc(x.exercise)}${x._pend?'<span class="pend">未送信</span>':""}</div><div>${x.type==="run"?`${x.min}分・${x.km}km・${esc(x.place)}${x.memo?"　"+esc(x.memo):""}`:esc(x.part)+"　"+esc(fmtSet(x))+(rirText(x)?"　"+rirText(x):"")+(x.memo?"　"+esc(x.memo):"")}</div></div><button class="del" data-id="${x.id}">編集</button></div>`).join(""):`<div class="empty">まだ記録はありません</div>`}
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
  const f=p=>{const a=v[p]||0;return a?`rgba(236,236,239,${(0.28+0.67*a).toFixed(2)})`:"#33353c"};
  const BASE="#1f2126",GAP="#0e0f12";
  const SIL=[
    "M50,30 L40,31 C34,32 30,35 29.5,41 C29.5,52 31,62 33,72 C34,80 33.5,88 33,95 L50,97 Z",
    "M29,35 C23,36 19.5,41 19.5,49 C19.5,58 20.5,66 20.5,73 C19.5,85 17.5,97 16.5,107 C16,114 20,117 22.5,112 C24.5,100 26.5,88 27.5,78 C29,68 30.5,56 30.5,45 Z",
    "M33,95 C31,110 31,126 33,140 C34,150 35,158 35,166 C34,180 34.5,196 36.5,212 L36,219 C38,224 44,224 45,219 L45,212 C46,196 47,180 46.5,166 C47.5,150 48.5,128 49.5,108 L50,97 Z"];
  const FRONT=[
    ["肩","M29,35.5 C23.5,36.5 20.5,41 20.5,48.5 C23,50.5 26,49.5 28.5,47 C30.5,43 31,39 29,35.5 Z"],
    ["胸","M49,36 L37,35.5 C32.5,37 30.5,41 31.2,46 C33,51.5 40,53.5 49,51.5 Z"],
    ["腕","M21.5,52 C20.5,58 21,66 22,72 C25,72 27,66 28,58 C28.2,53.5 25,50.5 21.5,52 Z"],
    ["腕","M21.2,76 C19.5,86 18.2,96 17.3,105.5 C19.2,106.8 21,106 22,104 C24,94 25.8,86 27,78.5 C25,75.5 23,75 21.2,76 Z"],
    ["腹・体幹","M43.5,54 L49,54 L49,61.5 L43.2,61.5 C42.8,58 43,56 43.5,54 Z"],
    ["腹・体幹","M43.2,63 L49,63 L49,71 L43.2,71 Z"],
    ["腹・体幹","M43.3,72.5 L49,72.5 L49,80.5 L43.6,80.5 Z"],
    ["腹・体幹","M43.8,82 L49,82 L49,94 C46.5,93 44.8,90 43.8,86 Z"],
    ["腹・体幹","M41.5,55 C37.5,56 34.5,60 34.2,66 C34,76 35,84 38.5,90.5 C40.5,86 41.8,78 41.8,70 Z"],
    ["脚","M34.2,100 C32.4,114 33,130 36,148 C39,152 43,152 45,148 C46,132 46.2,116 46,104 C42,100.5 37.5,99.2 34.2,100 Z"],
    ["脚","M47.6,104 C47.6,116 47,128 46.6,140 C48.2,134 49.2,120 49.4,106 Z"],
    ["脚","M36.4,170 C35.4,182 36.2,196 38,208 C40,208.8 42,208.6 43.4,206.5 C44.4,194 44.6,180 43.6,170 C41.5,166.5 38.4,166.5 36.4,170 Z"]];
  const BACK=[
    ["背中","M50,27 C46,28.5 41,31 34.5,34.2 C38.5,38.5 44,43 49.2,51 L50,51 Z"],
    ["肩","M29,35.5 C23.5,36.5 20.5,41 20.5,48.5 C23,50.5 26,49.5 28.5,47 C30.5,43 31,39 29,35.5 Z"],
    ["背中","M33.5,40 C31,46 31.2,56 33.2,66 C36,74 42,80 49.2,84 L49.2,57 C45,51 39.5,45 33.5,40 Z"],
    ["背中","M45.5,82 C44.6,87 44.6,92 46,95.5 L49.2,95.5 L49.2,85.5 Z"],
    ["腕","M21.5,52 C20.5,58 21,66 22,72 C25,72 27,66 28,58 C28.2,53.5 25,50.5 21.5,52 Z"],
    ["腕","M21.2,76 C19.5,86 18.2,96 17.3,105.5 C19.2,106.8 21,106 22,104 C24,94 25.8,86 27,78.5 C25,75.5 23,75 21.2,76 Z"],
    ["臀","M49.2,95 C44,94 37.5,95.5 34.3,100.5 C33.2,108 35.8,116 42,118 C45.8,118.2 48.4,116.4 49.2,113 Z"],
    ["脚","M35,121 C34,132 35,144 37,154 C40,156.2 43,156.2 45.2,154 C46.2,142 47,130 47.2,122 C43,119.5 38.4,119.4 35,121 Z"],
    ["脚","M36.2,166 C34.4,174 35.2,184 38,192 C41,193.4 44,192.6 45.2,190 C46.2,182 46.2,172 44.6,166 C41.6,162.6 38.4,162.6 36.2,166 Z"]];
  const half=(list,mir)=>`<g ${mir?'transform="translate(100,0) scale(-1,1)"':""}>${SIL.map(d=>`<path d="${d}" fill="${BASE}"/>`).join("")}${list.map(([p,d])=>`<path d="${d}" fill="${f(p)}" stroke="${GAP}" stroke-width=".7" stroke-linejoin="round"/>`).join("")}</g>`;
  const fig=(list,dx,label)=>`<g transform="translate(${dx},0)"><ellipse cx="50" cy="15" rx="8.5" ry="10.5" fill="${BASE}"/><path d="M45,23 L55,23 L56,31 L44,31 Z" fill="${BASE}"/>${half(list,false)}${half(list,true)}
    <text x="50" y="234" fill="#7d7f88" font-size="7" text-anchor="middle" font-family="Jost" letter-spacing="2">${label}</text></g>`;
  return `<svg viewBox="0 0 205 238" xmlns="http://www.w3.org/2000/svg">${fig(FRONT,0,"FRONT")}${fig(BACK,105,"BACK")}</svg>`}

function weekHtml(){const now=new Date();const dow=(now.getDay()+6)%7;
  const mon=new Date(now.getFullYear(),now.getMonth(),now.getDate()-dow);const days=[];for(let i=0;i<7;i++){const d=new Date(mon);d.setDate(mon.getDate()+i);days.push(ymd(d))}
  const sdays=new Set(entries.filter(x=>x.type==="strength").map(x=>x.date));
  const done=days.filter(d=>sdays.has(d)).length,GOAL=2;
  const last=[...sdays].filter(d=>d<=ymd(now)).sort().pop();
  const since=last?Math.round((new Date(ymd(now)+"T00:00")-new Date(last+"T00:00"))/86400000):null;
  const wd="月火水木金土日";
  return `<div class="week"><div class="wk-h"><span>THIS WEEK — 今週の筋トレ</span><b>${done}<i>/${GOAL}回</i></b></div>
    <div class="wk-d">${days.map((d,i)=>`<div class="${sdays.has(d)?"on":""} ${d===ymd(now)?"td":""}"><i>${sdays.has(d)?"🏋️":""}</i><span>${wd[i]}</span></div>`).join("")}</div>
    <div class="wk-f">${done>=GOAL?"今週の目標達成 ✓":`あと${GOAL-done}回`}${since!=null?`　・　${since===0?"今日やりました":`前回から${since}日`}`:""}</div></div>`}
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
  const tk=ymd(new Date());
  for(let d=1;d<=nd;d++){const k=key+"-"+pad(d),s=actDays[k];
    h+=`<div class="${s?"act":""}${k===tk?" today":""}" data-day="${k}"><div class="d">${d}</div><div class="ic">${s?(s.has("strength")?"🏋️":"")+(s.has("run")?"🏃":""):""}</div></div>`}
  const rest=(7-(first+nd)%7)%7;for(let i=0;i<rest;i++)h+=`<div class="out"></div>`;
  h+=`</div>`;
  h+=weekHtml();

  /* strength summary */
  const sets=a=>a.reduce((s,x)=>s+(x.sets||0),0);
  h+=`<div class="sec"><div class="sech"><span>STRENGTH — 筋トレ</span></div>`;
  if(!str.length){h+=`<div class="empty">この月の筋トレ記録はまだありません</div></div>`}
  else{
    h+=`<div class="stats"><div><b>${new Set(str.map(x=>x.date)).size}</b><span>DAYS</span></div><div><b>${sets(str)}</b><span>SETS</span></div><div><b>${new Set(str.map(x=>x.exercise)).size}</b><span>EXERCISES</span></div>${(()=>{const ds=[...new Set(str.map(x=>x.date))].map(d=>dayMinutes(inM.filter(x=>x.date===d))).filter(v=>v);return ds.length?`<div><b>${Math.round(ds.reduce((a,b)=>a+b,0)/ds.length)}<i>分</i></b><span>AVG TIME</span></div>`:""})()}</div>`;
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
        h+=`<div class="ex" data-ex="${esc(n)}"><div class="a"><span>${esc(n)} <em class="chv">›</em></span><span><b>${days.size}</b>日・<b>${sets(a)}</b>セット</span></div><div class="b"><div class="dotsw"><div class="dots">${dots}</div><div class="dlab">${[1,10,20,nd].map(d=>`<i style="left:${((d-0.5)/nd*100).toFixed(2)}%">${d}</i>`).join("")}</div></div><span>${esc(fmtSet(last))}</span></div></div>`})});
    h+=`</div>`}

  /* time trend */
  {const days=[...new Set(entries.filter(x=>x.type==="strength"&&x.started_at).map(x=>x.date))].sort().slice(-12);
   const data=days.map(d=>({d,m:dayMinutes(entries.filter(x=>x.date===d))})).filter(x=>x.m);
   h+=`<div class="sec"><div class="sech"><span>TIME — トレーニング時間</span><span>直近${data.length}回</span></div>`;
   if(!data.length)h+=`<div class="empty">メニューから記録すると、ここに毎回の時間の推移が出ます</div>`;
   else{const mx=Math.max(...data.map(x=>x.m))*1.1;const avg=Math.round(data.reduce((a,b)=>a+b.m,0)/data.length);
     const mn=Math.min(...data.map(x=>x.m));
     h+=`<div class="stats"><div><b>${data[data.length-1].m}<i>分</i></b><span>前回</span></div><div><b>${avg}<i>分</i></b><span>平均</span></div><div><b>${mn}<i>分</i></b><span>最短</span></div></div>
     <div class="tbars">${data.map(x=>`<div><i style="height:${x.m/mx*100}%"><b>${x.m}</b></i><span>${x.d.slice(5).replace("-","/")}</span></div>`).join("")}</div>`}
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


/* ---------- exercise progress chart ---------- */
function openChart(name){const list=entries.filter(x=>x.type==="strength"&&x.exercise===name).sort((a,b)=>(a.date+a.ts).localeCompare(b.date+b.ts));
  if(!list.length)return;const m=findM(name);
  const bw=list.every(x=>{const sl=setsOf(x);return sl?sl.every(s=>s.w==null):x.weight==null});
  const pts=list.map(x=>{const sl=setsOf(x);let v;
    if(bw)v=sl?sl.reduce((a,s)=>a+(s.r||0),0):(parseInt(x.reps,10)||0)*(x.sets||1);
    else v=sl?Math.max(...sl.map(s=>s.w??0)):(x.weight||0);return{d:x.date,v,x}});
  const W=330,H=170,L=34,R=10,T=14,B=26;const vs=pts.map(p=>p.v);let lo=Math.min(...vs),hi=Math.max(...vs);
  if(lo===hi){lo=Math.max(0,lo-5);hi=hi+5}const pad_=(hi-lo)*0.12;lo=Math.max(0,lo-pad_);hi=hi+pad_;
  const X=i=>pts.length===1?L+(W-L-R)/2:L+i*(W-L-R)/(pts.length-1),Y=v=>T+(H-T-B)*(1-(v-lo)/(hi-lo));
  const ticks=[lo,(lo+hi)/2,hi].map(v=>Math.round(v));
  const idxs=[...new Set([0,Math.floor((pts.length-1)/2),pts.length-1])];
  let svg=`<svg viewBox="0 0 ${W} ${H}" class="chart">${ticks.map(t=>`<line x1="${L}" x2="${W-R}" y1="${Y(t)}" y2="${Y(t)}" stroke="#24262c"/><text x="${L-6}" y="${Y(t)+3}" text-anchor="end">${t}</text>`).join("")}
    <polyline fill="none" stroke="#ececef" stroke-width="2" stroke-linejoin="round" points="${pts.map((p,i)=>X(i)+","+Y(p.v)).join(" ")}"/>
    ${pts.map((p,i)=>`<circle cx="${X(i)}" cy="${Y(p.v)}" r="3.5" fill="#0e0f12" stroke="#ececef" stroke-width="2"/>`).join("")}
    ${idxs.map(i=>`<text x="${X(i)}" y="${H-8}" text-anchor="middle">${pts[i].d.slice(5).replace("-","/")}</text>`).join("")}</svg>`;
  const first=pts[0].v,last=pts[pts.length-1].v,diff=last-first;
  const unit=bw?(m&&m.sec?"秒（合計）":"回（合計）"):"kg";
  $("chartBody").innerHTML=`<div class="shh"><b>${esc(name)}</b><button class="x" id="chartClose">✕</button></div>
    <div class="cap" style="margin:4px 0 2px">${bw?"1回あたりの合計回数":"一番重いセットの重さ"}の推移（${pts.length}回分）</div>
    <div class="stats" style="margin:8px 0"><div><b>${last}<i>${bw?"":"kg"}</i></b><span>最新</span></div><div><b>${diff>0?"+":""}${Math.round(diff*10)/10}<i>${bw?"":"kg"}</i></b><span>最初から</span></div><div><b>${Math.max(...vs)}<i>${bw?"":"kg"}</i></b><span>最高</span></div></div>
    ${svg}<div class="hint">縦軸：${unit}</div>
    <div class="cap" style="margin-top:16px">履歴</div>
    ${pts.slice().reverse().map(p=>`<div class="item"><div class="t"><div>${p.d.slice(5).replace("-","/")}　${esc(fmtSet(p.x))}${rirText(p.x)?"　"+rirText(p.x):""}</div>${p.x.memo?`<div>${esc(p.x.memo)}</div>`:""}</div></div>`).join("")}`;
  $("chartSheet").classList.remove("hidden");document.body.style.overflow="hidden"}
function closeChart(){$("chartSheet").classList.add("hidden");document.body.style.overflow=""}
$("chartSheet").addEventListener("click",e=>{if(e.target.id==="chartSheet"||e.target.id==="chartClose")closeChart()});

/* ---------- calendar -> day ---------- */
$("monthBody").addEventListener("click",e=>{const ex=e.target.closest("[data-ex]");if(ex){openChart(ex.dataset.ex);return}
  const c=e.target.closest("[data-day]");if(!c)return;
  $("date").value=c.dataset.day;syncQuick();renderDay();location.hash="log";
  setTimeout(()=>$("dayCap").scrollIntoView({behavior:"smooth",block:"start"}),60)});

/* ---------- edit sheet ---------- */
let ed=null;
function openEdit(id){const x=entries.find(e=>e.id===id);if(!x)return;
  ed={id,type:x.type,date:x.date,memo:x.memo||"",exercise:x.exercise,part:x.part,unilateral:!!x.unilateral,
    min:x.min,km:x.km,place:x.place||"屋内",
    sets:x.type==="strength"?(setsOf(x)?setsOf(x).map(s=>({w:s.w,r:s.r,rir:s.rir??null})):Array.from({length:x.sets||1},()=>({w:x.weight??null,r:parseInt(x.reps,10)||null}))):[],
    sec:x.exercise==="プランク",sure:false};
  renderEdit();$("sheet").classList.remove("hidden");document.body.style.overflow="hidden"}
function closeEdit(){ed=null;$("sheet").classList.add("hidden");document.body.style.overflow=""}
function renderEdit(){if(!ed)return;const u=ed.sec?"秒":"回";
  let h=`<div class="shh"><b>${ed.type==="run"?"🏃 ラン":"🏋️ "+esc(ed.exercise)}</b><button class="x" data-e="close">✕</button></div>
  <small class="lbl">日付</small><input type="date" data-ef="date" value="${ed.date}">`;
  if(ed.type==="strength"){
    h+=`<small class="lbl">セット${ed.unilateral?"（"+(uniLabel(findM(ed.exercise))||"片脚")+"）":""}</small>`+ed.sets.map((s,i)=>`<div class="srow"><span class="no" style="border:none">${i+1}</span>
      <div class="stp"><button data-e="w-" data-i="${i}">−</button><input inputmode="decimal" data-ef="w" data-i="${i}" value="${s.w??""}" placeholder="自重"><span class="unit" style="align-self:center">kg</span><button data-e="w+" data-i="${i}">＋</button></div>
      <div class="stp"><button data-e="r-" data-i="${i}">−</button><input inputmode="numeric" data-ef="r" data-i="${i}" value="${s.r??""}"><span class="unit" style="align-self:center">${u}</span><button data-e="r+" data-i="${i}">＋</button></div>
      <button class="rm" data-e="rm" data-i="${i}">×</button></div>${rirPicker("data-e",i,s.rir)}`).join("")+`<button class="ad" data-e="add">＋ セットを追加</button>`;
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
  else if(a==="rir"){const s=ed.sets[i],v=+b.dataset.v;s.rir=s.rir===v?null:v}
  else if(a==="add"){const l=ed.sets[ed.sets.length-1]||{w:null,r:null};ed.sets.push({w:l.w,r:l.r})}
  else if(a==="rm"){ed.sets.splice(i,1)}
  else if(a==="w-"||a==="w+"||a==="r-"||a==="r+"){const s=ed.sets[i],d=a.endsWith("+")?1:-1;
    if(a[0]==="w")s.w=Math.max(0,(s.w||0)+d*stepOf(ed.exercise,s.w))||null;else s.r=Math.max(0,(s.r||0)+d*(ed.sec?5:1))}
  else if(a==="del"){if(!ed.sure){ed.sure=true;renderEdit();return}removeEntry(ed.id);closeEdit();toast("削除しました");return}
  else if(a==="save"){let patch={date:ed.date||ymd(today),memo:ed.memo.trim()||null};
    if(ed.type==="strength"){if(!ed.sets.length){toast("セットが0です。削除する場合は下のボタンから");return}
      const sl=ed.sets.map(s=>{const z={w:s.w??null,r:s.r??null};if(s.rir!=null)z.rir=s.rir;return z});const ws=sl.map(s=>s.w).filter(v=>v!=null);
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
function beep(){if(!actx)return;[0,0.2,0.4,0.6].forEach(t=>{const o=actx.createOscillator(),g=actx.createGain();o.type="square";o.frequency.value=t%0.4?1320:990;o.connect(g);g.connect(actx.destination);
  const at=actx.currentTime+t;g.gain.setValueAtTime(0.0001,at);g.gain.exponentialRampToValueAtTime(0.5,at+0.01);g.gain.exponentialRampToValueAtTime(0.0001,at+0.16);o.start(at);o.stop(at+0.2)})}
async function keepAwake(on){try{if(on&&navigator.wakeLock&&!wlock){wlock=await navigator.wakeLock.request("screen");wlock.addEventListener("release",()=>wlock=null)}
  if(!on&&wlock){await wlock.release();wlock=null}}catch(_){}}
function fmtT(sec){sec=Math.max(0,Math.ceil(sec));return Math.floor(sec/60)+":"+pad(sec%60)}
function renderTimer(){const el=$("timer");if(!tEnd&&!tDone){el.classList.add("hidden");return}
  el.classList.remove("hidden");const left=(tEnd-Date.now())/1000;
  el.classList.toggle("done",tDone);
  $("tTime").textContent=tDone?"0:00":fmtT(left);$("tLabel").textContent=tDone?"休憩終了！次のセットへ":"休憩中"+(tNote?`（${tNote}）`:"");
  $("tBar").style.width=tDone?"100%":Math.min(100,(1-left/tCur)*100)+"%"}
let tCur=90,tStart=0,tNote="";
function startTimer(len,note){unlockAudio();alarmOff();$("timer").classList.remove("soon");tCur=len||tLen;tNote=note||"";tStart=Date.now();tEnd=tStart+tCur*1000;tDone=false;keepAwake(true);
  clearInterval(tTick);tTick=setInterval(tick,250);renderTimer();renderRestChips()}
let lastTickSec=-1,alarmIv=null;
function tone(f,d,v){if(!actx)return;const o=actx.createOscillator(),g=actx.createGain();o.type="square";o.frequency.value=f;o.connect(g);g.connect(actx.destination);
  const at=actx.currentTime;g.gain.setValueAtTime(0.0001,at);g.gain.exponentialRampToValueAtTime(v||0.3,at+0.01);g.gain.exponentialRampToValueAtTime(0.0001,at+d);o.start(at);o.stop(at+d+0.05)}
function alarmOn(){$("tOver").classList.remove("hidden");let n=0;
  const ring=()=>{beep();if(navigator.vibrate)try{navigator.vibrate([400,150,400])}catch(_){}
    if(++n>=12)alarmOff()};
  ring();clearInterval(alarmIv);alarmIv=setInterval(ring,1600)}
function alarmOff(){clearInterval(alarmIv);alarmIv=null;$("tOver").classList.add("hidden");if(tDone){tDone=false;renderTimer();keepAwake(false)}}
function tick(){if(!tEnd)return;const left=(tEnd-Date.now())/1000;
  if(left<=0){tEnd=0;tDone=true;clearInterval(tTick);lastTickSec=-1;renderTimer();alarmOn();return}
  const sec=Math.ceil(left);if(sec<=3&&sec!==lastTickSec){lastTickSec=sec;tone(660,0.12,0.25)}
  $("timer").classList.toggle("soon",left<=5);
  renderTimer()}
function stopTimer(){tEnd=0;tDone=false;clearInterval(tTick);alarmOff();keepAwake(false);$("timer").classList.remove("soon");renderTimer()}
function renderRestChips(){$("restSeg").innerHTML=[60,90,120].map(v=>`<button class="chip ${v===tLen?"on":""}" data-r="${v}">${v}秒</button>`).join("")+`<button class="chip" data-r="go">⏱ スタート</button>`}
$("restSeg").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.r==="go"){startTimer();return}
  tLen=+b.dataset.r;try{localStorage.setItem("wl_rest",tLen)}catch(_){}
  if(tEnd)startTimer(tLen);else renderRestChips()};
$("timer").onclick=e=>{const b=e.target.closest("button");if(!b)return;
  if(b.dataset.t==="stop"){stopTimer();return}
  if(tDone){startTimer();return}
  tEnd+=(+b.dataset.t)*1000;tCur=Math.max(10,tCur+(+b.dataset.t));renderTimer()};
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){tick();if(tEnd)keepAwake(true)}});
$("tOver").onclick=e=>{const b=e.target.closest("[data-o]");
  if(b&&b.dataset.o==="again"){startTimer();return}
  stopTimer()};
renderRestChips();
document.addEventListener("click",e=>{if(e.target.id==="sessReset"){try{localStorage.removeItem("wl_sess")}catch(_){}renderElapsed();toast("開始時刻をリセットしました")}});

/* ---------- Claudeに相談 ---------- */
function buildConsult(){const since=new Date();since.setDate(since.getDate()-42);const sk=ymd(since);
  const rows=entries.filter(x=>x.date>=sk).sort((a,b)=>(a.date+a.ts).localeCompare(b.date+b.ts));
  const byDate={};rows.forEach(x=>(byDate[x.date]=byDate[x.date]||[]).push(x));
  let t="運動ログアプリの直近6週間の記録です。フォームや重量設定、違和感についてアドバイスをください。\n";
  t+="（ルール：3セット全部で15回できたら次回1段階上げる／セット間休憩"+tLen+"秒）\n\n";
  Object.keys(byDate).forEach(d=>{t+="■ "+d+"\n";byDate[d].forEach(x=>{
    t+=x.type==="run"?`- ラン ${x.min}分 ${x.km}km ${x.place||""}${x.memo?"（"+x.memo+"）":""}\n`
      :`- ${x.exercise}：${fmtSet(x)}${rirWords(x)?"（"+rirWords(x)+"）":""}${x.memo?"（メモ："+x.memo+"）":""}\n`})});
  const notes=rows.filter(x=>x.memo);
  if(notes.length)t+="\n【メモがある記録】\n"+notes.map(x=>`${x.date.slice(5)} ${x.exercise||"ラン"}：${x.memo}`).join("\n")+"\n";
  return t}
function askPrompt(){return `運動ログアプリの記録（Supabaseプロジェクト「workout-log」、ID: twixkmtxfneivijvupyu の workouts テーブル）を読んで、直近の筋トレについてアドバイスをください。前回からの変化、次回の重さの目安、メモにある違和感への対処を中心にお願いします。（今日は${ymd(new Date())}）`}
const ASK_DEFAULT="https://claude.ai/code/session_01Bw63Nz2BF8o3EN42vdwFbR";
function askUrl(){let u;try{u=localStorage.getItem("wl_askurl")}catch(_){}return u==null?ASK_DEFAULT:u}
$("askUrl").value=askUrl();
$("askUrl").addEventListener("change",()=>{const v=$("askUrl").value.trim();
  if(v&&!/^https:\/\/claude\.ai\//.test(v)){toast("claude.ai のURLを入れてください");$("askUrl").value=askUrl();return}
  try{localStorage.setItem("wl_askurl",v)}catch(_){}toast(v?"相談チャットを保存しました":"毎回新しいチャットで開きます")});
$("askApp").addEventListener("click",async e=>{const u=askUrl(),q=askPrompt();
  if(!u){$("askApp").href="https://claude.ai/new?q="+encodeURIComponent(q);return}
  $("askApp").href=u;
  try{await navigator.clipboard.writeText(q);toast("相談文をコピーしました。貼り付けて送信してください")}catch(_){}});
try{$("tipsAlways").checked=localStorage.getItem("wl_tips_always")==="1"}catch(_){}
$("tipsAlways").onchange=()=>{try{localStorage.setItem("wl_tips_always",$("tipsAlways").checked?"1":"0")}catch(_){}renderMenu();toast($("tipsAlways").checked?"注意点を毎回表示します":"慣れた種目の注意点は自動で隠します")};
$("consult").onclick=async()=>{const t=buildConsult();
  try{await navigator.clipboard.writeText(t);toast("コピーしました。Claudeに貼り付けてください")}
  catch(_){const b=$("csvBox");b.value=t;b.classList.remove("hidden");b.select();toast("下の欄から全選択してコピーしてください")}};

/* ---------- auth ---------- */
let signUpMode = false;
function showApp(on) {
  $("auth").classList.toggle("hidden", on);
  $("nav").classList.toggle("hidden", !on);
  if (on) route(); else { $("v-log").classList.add("hidden"); $("v-month").classList.add("hidden"); $("v-settings").classList.add("hidden"); $("saveBar").classList.add("hidden"); }
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
/* ---------- ショートカットからのラン取り込み（?run=1&min=..&km=..&place=..&date=..&memo=..） ---------- */
let runIn=null;
(()=>{try{const q=new URLSearchParams(location.search);
  if(q.has("run")){runIn={min:q.get("min"),km:q.get("km"),place:q.get("place"),date:q.get("date"),memo:q.get("memo")};
    sessionStorage.setItem("wl_runin",JSON.stringify(runIn));history.replaceState(null,"",location.pathname+"#log")}
  else{const v=sessionStorage.getItem("wl_runin");if(v)runIn=JSON.parse(v)}}catch(_){}})();
function applyRunIn(){if(!runIn)return;const r=runIn;runIn=null;try{sessionStorage.removeItem("wl_runin")}catch(_){}
  const num=v=>{const n=parseFloat(String(v||"").replace(/[^0-9.]/g,""));return isNaN(n)?"":n};
  let mn=num(r.min),km=num(r.km);
  if(mn!=="")mn=Math.round(mn*10)/10; if(km!=="")km=Math.round(km*100)/100;
  location.hash="log";
  document.querySelector('#typeSeg [data-t="run"]').click();
  if(r.date&&/^\d{4}-\d{2}-\d{2}/.test(r.date)){$("date").value=r.date.slice(0,10);syncQuick();renderDay()}
  $("rmin").value=mn;$("rkm").value=km;
  if(r.place){const pl=/外|out/i.test(r.place)?"屋外":/内|in/i.test(r.place)?"屋内":null;
    if(pl)document.querySelector(`#placeSeg [data-p="${pl}"]`).click()}
  if(r.memo)$("rmemo").value=r.memo;
  runPace();toast("ランの記録を読み込みました。確認して「記録する」を押してください")}
async function onSession(s) {
  const changed = (s?.user?.id) !== (session?.user?.id);
  session = s;
  if (!s) { entries = []; server = []; pending = []; ready = false; showApp(false); return; }
  $("who").textContent = s.user.email || "";
  showApp(true);
  if (changed) await load();
  applyRunIn();
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
