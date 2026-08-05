// Perf panel against a real, running app.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless:true, args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p = await b.newPage();
await p.setViewport({width:1440,height:900});
let fail=0; const check=(l,ok,d="")=>{console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`); if(!ok)fail++;};
p.on("pageerror", e=>{console.log("[pageerror]",String(e)); fail++;});
await p.goto(process.argv[2], {waitUntil:"networkidle2"});
await p.waitForFunction(()=>/ANDROID\s+\d/i.test(document.body.innerText),{timeout:90000,polling:1000});
const click=async(sel,t)=>{const h=await p.evaluateHandle((s,w)=>[...document.querySelectorAll(s)].find(n=>n.textContent.includes(w)),sel,t);await h.asElement().click();};
await click("button.tab","应用");
await p.waitForFunction(()=>document.querySelectorAll(".app-card").length>0,{timeout:90000,polling:500});
// documentsui was just launched, so it has a live process to sample.
const target = await p.evaluate(()=>{
  const c=[...document.querySelectorAll(".app-card")].find(x=>(x.getAttribute("title")||"").includes("documentsui"));
  if(c) c.click();
  return c?.getAttribute("title") ?? null;
});
check("selected a running app", !!target, target ?? "not found");
await p.waitForFunction(()=>document.body.innerText.includes("性能"),{timeout:30000,polling:300});
check("perf section renders in the detail panel", true);
await click("button","开始采样");
const got = await p.waitForFunction(()=>{
  const t=document.body.innerText;
  return /CPU/.test(t) && document.querySelectorAll(".spark").length>0;
},{timeout:60000,polling:1000}).then(()=>true).catch(()=>false);
check("sparklines appear", got);
await new Promise(r=>setTimeout(r,9000));
const vals = await p.evaluate(()=>{
  const out={};
  document.querySelectorAll(".stat").forEach(s=>{
    const k=s.querySelector(".k")?.textContent?.trim(); const v=s.querySelector(".v")?.textContent?.trim();
    if(k && v && ["CPU","内存 PSS","掉帧"].includes(k)) out[k]=v;
  });
  return out;
});
console.log("   measured:", JSON.stringify(vals, null, 0));
check("CPU has a value", !!vals["CPU"] && vals["CPU"]!=="—", vals["CPU"]);
check("memory has a value", !!vals["内存 PSS"] && vals["内存 PSS"]!=="—", vals["内存 PSS"]);
check("points accumulate", await p.evaluate(()=>{
  const pl=document.querySelector(".spark polyline:last-of-type");
  return (pl?.getAttribute("points")?.split(" ").length ?? 0) >= 2;
}));
await p.screenshot({path: process.argv[3]+"/perf.png"});
await click("button","停止");
await b.close();
console.log(fail===0?"\nPERF OK":`\n${fail} FAILED`);
process.exit(fail===0?0:1);
