// Auto-connect: loading the page should connect a device with no interaction.
//
//   npm run verify:auto -- http://127.0.0.1:7070 [screenshotDir]
//
// Needs a backend whose adb server actually has a device attached — the remote
// NAS has none, so point this at a local bridge.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless:true, args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p = await b.newPage();
await p.setViewport({width:1440,height:900});
p.on("pageerror", e=>console.log("[pageerror]", String(e)));
await p.goto(process.argv[2], {waitUntil:"networkidle2"});
console.log("loaded; clicking nothing…");
const ok = await p.waitForFunction(
  () => /ANDROID\s+\d/i.test(document.body.innerText) && !!document.querySelector("button.device.active"),
  {timeout:90000, polling:1000}).then(()=>true).catch(()=>false);
console.log("auto-connected:", ok);
console.log("device shown:", await p.evaluate(()=>document.querySelector(".hero .big")?.textContent ?? "(none)"));
console.log("remembered serial:", await p.evaluate(()=>localStorage.getItem("adbstudio.lastDevice")));
console.log("no busy overlay shown:", await p.evaluate(()=>!document.querySelector(".busy")));
await p.screenshot({path: process.argv[3]+"/autoconnect.png"});
await b.close();
process.exit(ok?0:1);
