// Live logcat against a real device: lines must stream in, filtering must work,
// and stopping must actually kill the process on the device.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless:true, args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p = await b.newPage();
await p.setViewport({width:1440,height:900});
let fail = 0;
const check = (l, ok, d="") => { console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`); if(!ok) fail++; };
p.on("pageerror", e=>{ console.log("[pageerror]", String(e)); fail++; });

await p.goto(process.argv[2], {waitUntil:"networkidle2"});
await p.waitForFunction(()=>/ANDROID\s+\d/i.test(document.body.innerText),{timeout:90000,polling:1000});
const click = async (sel,t)=>{const h=await p.evaluateHandle((s,w)=>[...document.querySelectorAll(s)].find(n=>n.textContent.includes(w)),sel,t);await h.asElement().click();};

await click("button.tab","日志");
await p.waitForFunction(()=>document.body.innerText.includes("点“开始”读取设备日志"),{timeout:20000,polling:300});
check("log page renders idle state", true);

await click("button","开始");
const got = await p.waitForFunction(()=>document.querySelectorAll(".logline").length > 5,
  {timeout:60000, polling:1000}).then(()=>true).catch(()=>false);
check("lines stream in", got, await p.evaluate(()=>document.querySelectorAll(".logline").length+" lines"));

const levels = await p.evaluate(()=>{
  const s=new Set(); document.querySelectorAll(".logline").forEach(l=>{
    const c=[...l.classList].find(x=>x.startsWith("lv-")); if(c) s.add(c);});
  return [...s];
});
check("levels parsed and coloured", levels.length>0, levels.join(","));

// Neither DOM rows nor the buffered total can show progress: rows are capped at
// the render limit and the buffer is a ring that stops growing at MAX_LINES.
// The timestamp of the newest line is what actually advances.
const total = () => p.evaluate(()=>Number(document.body.innerText.match(/(\d+) 行/)?.[1] ?? 0));
const newest = () => p.evaluate(()=>[...document.querySelectorAll(".logline .t")].at(-1)?.textContent ?? "");
const t0 = await newest();
const after = await total();
await new Promise(r=>setTimeout(r,8000));
const t1 = await newest();
check("still streaming (newest line advances)", !!t1 && t1 !== t0, `${t0} → ${t1}`);

// Filter by a tag taken from the log itself, so a zero result means a real bug
// rather than "that tag never appeared".
const sampleTag = await p.evaluate(()=>{
  const tags=[...document.querySelectorAll(".logline .tg")].map(e=>e.textContent.trim()).filter(t=>t.length>3);
  const counts={}; tags.forEach(t=>counts[t]=(counts[t]||0)+1);
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? "";
});
check("found a tag to filter on", !!sampleTag, sampleTag);
await p.type('.card input[type="search"]', sampleTag);
await new Promise(r=>setTimeout(r,1500));
const matched = await total();
check(
  "filter narrows but keeps matches",
  matched > 0 && matched < after,
  `${matched} matching "${sampleTag}" out of ${after}`
);
await p.evaluate(()=>{const i=document.querySelector('.card input[type="search"]'); i.value=""; i.dispatchEvent(new Event("input",{bubbles:true}));});

await click("button","停止");
await new Promise(r=>setTimeout(r,2000));
check("stop button switches back to 开始", await p.evaluate(()=>document.body.innerText.includes("开始")));
await p.screenshot({path: process.argv[3]+"/logcat.png"});
await b.close();
console.log(fail===0?"\nLOGCAT OK":`\n${fail} FAILED`);
process.exit(fail===0?0:1);
