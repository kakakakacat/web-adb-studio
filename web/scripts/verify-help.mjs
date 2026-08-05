// The Help modal is the only place bridge mode can be switched on, and bridge
// mode is the answer to "device busy" — so if this panel regresses, the fix
// becomes unreachable and users are left with `adb kill-server`.
//
// Text assertions are case-insensitive on purpose: the headings carry
// `text-transform: uppercase` and innerText reflects it, so `WebUSB` reads back
// as `WEBUSB`.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--no-sandbox"]});
const p = await b.newPage(); await p.setViewport({width:1440,height:900});
let fail=0; const check=(l,ok,d="")=>{console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`); if(!ok)fail++;};
p.on("pageerror",e=>{console.log("[pageerror]",String(e));fail++;});
await p.goto("http://127.0.0.1:7070",{waitUntil:"networkidle2"});
await p.click('button[title="连接方式 / 环境自检"]');
await p.waitForFunction(()=>document.body.innerText.includes("连接方式"),{timeout:10000});
const t=await p.evaluate(()=>document.body.innerText);
check("zero-install WebUSB is presented first", /方式一：WebUSB 直连/i.test(t));
check("one-click button present", [...await p.$$("button")].length>0 && t.includes("用本机桥接"));
check("script name is shown", t.includes("./scripts/bridge.sh"));

// The download links are the whole point on a machine with no source. Assert
// they are offered AND that the bytes are actually there — a link to a 404 is
// worse than no link, because the user goes looking for what they did wrong.
const links = await p.evaluate(()=>[...document.querySelectorAll('a[href*="/download/"]')].map(a=>a.getAttribute("href")));
check("all three platform downloads offered", links.length===3, links.join(", "));
for (const href of links) {
  const st = await p.evaluate(async (u)=>(await fetch(u)).status, href);
  const len = await p.evaluate(async (u)=>(await fetch(u)).headers.get("content-length"), href);
  check(`download works: ${href.split("/").pop()}`, st===200 && Number(len)>100000, `status=${st} bytes=${len}`);
}
check("one is highlighted as this machine's", /你的系统/.test(t));
check("LNA permission is explained", t.includes("访问本地网络") && t.includes("Local Network Access"));
check("current target shown", /当前：/.test(t));
check("bridge is the second, opt-in path", /方式二：本机 adb 桥接/i.test(t));
// Read the pill of the bridge row itself; a nearby row's pill is not evidence.
const bridgePill = await p.evaluate(()=>{
  const row=[...document.querySelectorAll(".list-row")].find(r=>r.innerText.includes("adb 桥接"));
  return row ? row.querySelector(".pill").innerText : "(row missing)";
});
check("optional bridge is never reported as a fault", bridgePill!=="缺失", `pill=${bridgePill}`);
// clicking it must set the override and report a result rather than doing nothing
const btn=await p.evaluateHandle(()=>[...document.querySelectorAll("button")].find(n=>n.textContent.trim()==="用本机桥接"));
await btn.asElement().click();
await p.waitForFunction(()=>/已连上 adb 桥接|桥接不可达/.test(document.body.innerText),{timeout:20000});
const stored=await p.evaluate(()=>localStorage.getItem("adbstudio.bridgeUrl"));
check("click stores the local bridge url", stored==="ws://127.0.0.1:7070/api/adb", String(stored));
await b.close();
console.log(fail?`\n${fail} FAILED`:"\nHELP/BRIDGE UI OK");
process.exit(fail?1:0);
