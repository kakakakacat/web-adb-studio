// Keyboard/clipboard input — what can be verified without a text field on screen.
//
// This device is a stripped custom ROM with no focusable EditText anywhere, so
// "the characters landed in a field" can't be asserted here. What IS asserted:
// the control messages are accepted by the device (a rejected message throws and
// surfaces as a page error) and the UI is wired.
import puppeteer from "puppeteer-core";
let fail=0; const check=(l,ok,d="")=>{console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`); if(!ok)fail++;};
const b = await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless:true, args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p = await b.newPage();
await p.setViewport({width:1440,height:900});
const errs=[]; p.on("pageerror", e=>errs.push(String(e)));
p.on("console", m=>{ if(m.type()==="error") errs.push(m.text()); });
await p.goto(process.argv[2], {waitUntil:"networkidle2"});
await p.waitForFunction(()=>/ANDROID\s+\d/i.test(document.body.innerText),{timeout:90000,polling:1000});
const click=async(sel,t)=>{const h=await p.evaluateHandle((s,w)=>[...document.querySelectorAll(s)].find(n=>n.textContent.includes(w)),sel,t);await h.asElement().click();};
await click("button.tab","投屏");
await click("button","开始投屏");
const up=await p.waitForFunction(()=>{const c=document.querySelector(".screen canvas");return c&&c.width>300;},{timeout:90000,polling:1000}).then(()=>true).catch(()=>false);
check("mirroring started", up);
if(!up){ await b.close(); process.exit(1); }

check("canvas is focusable (needed for key events)",
  await p.evaluate(()=>document.querySelector(".screen canvas")?.getAttribute("tabindex")==="0"));
check("text box and keyboard toggle wired",
  await p.evaluate(()=>!!document.querySelector('input[placeholder*="输入文本"]') && /键盘/.test(document.body.innerText)));

// ASCII through the key path, control keys through the keycode path.
await p.evaluate(()=>document.querySelector(".screen canvas").focus());
await p.keyboard.type("hello");
await p.keyboard.press("Enter");
await p.keyboard.press("Backspace");
await p.keyboard.press("ArrowLeft");
await new Promise(r=>setTimeout(r,2500));
check("ASCII + control keys accepted by the device", errs.length===0, errs.slice(0,2).join(" | "));

// CJK through the clipboard path.
await p.type('input[placeholder*="输入文本"]', "中文测试");
await click("button","发送");
await new Promise(r=>setTimeout(r,2500));
check("clipboard paste accepted by the device", errs.length===0, errs.slice(0,2).join(" | "));
check("input box cleared after sending",
  await p.evaluate(()=>document.querySelector('input[placeholder*="输入文本"]')?.value===""));

await click("button","停止");
await b.close();
console.log(fail===0?"\nKEYBOARD WIRING OK (text-in-field needs a manual check)":`\n${fail} FAILED`);
process.exit(fail===0?0:1);
