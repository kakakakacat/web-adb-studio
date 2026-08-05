// root / remount against a real device, and what happens to the connection.
//
// `adb root` restarts adbd. The adb server keys connections by transport id and
// a restarted daemon comes back under a new one, so the object the page was
// holding is dead the moment the command succeeds — which is how "root失败：no
// device with transport id '12'" happened, and why the next few actions failed
// too. Clicking root must therefore leave the page on a *working* connection.
//
//   node scripts/verify-root-reconnect.mjs [url]
//
// Needs a userdebug device; on a production build root is refused and that
// refusal is checked instead.
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

// Drop root first, so clicking root in the page genuinely restarts adbd. On an
// already-rooted device `root:` is a no-op that never invalidates the transport,
// and the regression this test exists for would go unexercised.
try {
  execSync("adb unroot", { stdio: "pipe" });
  execSync("adb wait-for-device", { stdio: "pipe" });
  console.log("adb unroot: done (root will now actually restart adbd)");
} catch {
  console.log("adb unroot failed or unavailable — root may be a no-op below");
}

const URL_ = process.argv[2] ?? "http://127.0.0.1:7070";
let fail = 0;
const check = (l, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

const b = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const pageErrors = [];
p.on("pageerror", (e) => pageErrors.push(String(e)));
await p.goto(URL_, { waitUntil: "networkidle2" });
await p.waitForFunction(() => /ANDROID\s+\d/i.test(document.body.innerText), {
  timeout: 90000,
  polling: 1000,
});

// Buttons only. Including `.tile` in the selector matched an outer wrapper that
// sits earlier in document order, and clicking that does nothing — which looked
// exactly like the operation hanging.
const clickTile = async (label) => {
  const h = await p.evaluateHandle(
    (w) => [...document.querySelectorAll("button")].find((n) => n.textContent.trim() === w),
    label
  );
  const el = h.asElement();
  if (!el) throw new Error(`no button labelled ${label}`);
  await el.click();
};
const toastText = () =>
  p.evaluate(() => [...document.querySelectorAll(".toast, .toasts *")].map((n) => n.textContent).join(" | "));

// Liveness is proved by a command that must reach the daemon, and `remount` is
// exactly that — so the sequence root → remount doubles as the regression test:
// before the fix, the second click failed with "no device with transport id".
//
// Deliberately NOT the app list: loading it fires dozens of icon reads that
// queue ahead of everything else on the relay, which made an earlier version of
// this test time out on a run that had worked.
// Clear the tray, click, then wait for anything to appear. Neither counting
// toasts nor diffing their text works: they auto-dismiss, and two remounts in a
// row produce byte-identical output — so "a toast I have not seen" is never true
// the second time. Starting from empty is the only unambiguous signal.
const dismissAll = async () => {
  await p.evaluate(() => {
    for (const btn of document.querySelectorAll(".toast button, .toast .close, .toast [role=button]")) {
      btn.click();
    }
  });
  await p
    .waitForFunction(() => document.querySelectorAll(".toast").length === 0, {
      timeout: 15000,
      polling: 200,
    })
    .catch(() => {});
};
const newToastAfter = async (label, timeout = 90000) => {
  await dismissAll();
  await clickTile(label);
  // Skip the transient "reconnecting, retrying…" notice: it is progress, not the
  // outcome, and treating it as the result reported a failure for an operation
  // that went on to succeed.
  await p.waitForFunction(
    () =>
      [...document.querySelectorAll(".toast")].some(
        (n) => !/正在重连|重连后重试/.test(n.textContent || "")
      ),
    { timeout, polling: 400 }
  );
  return p.evaluate(() =>
    [...document.querySelectorAll(".toast")]
      .map((n) => n.textContent.trim())
      .filter((t) => !/正在重连|重连后重试/.test(t))
      .join(" | ")
  );
};

const rootReply = await newToastAfter("root");
console.log("   root ->", rootReply.slice(0, 90));
check(
  "root reported without a raw transport-id error",
  !/transport id/i.test(rootReply),
  rootReply.slice(0, 120)
);
const refused = /cannot run as root|production build/i.test(rootReply);

if (!refused) {
  // This is the regression: a command on the connection root just restarted.
  const remountReply = await newToastAfter("remount");
  console.log("   remount ->", remountReply.slice(0, 90).replace(/\n/g, " / "));
  check(
    "remount works on the connection root left behind",
    !/transport id/i.test(remountReply) && /Remount succeeded|already|as RW/i.test(remountReply),
    remountReply.slice(0, 140)
  );

  // And once more, to be sure the session is durably usable rather than good for
  // exactly one command.
  const again = await newToastAfter("remount");
  check(
    "still usable for a second command",
    !/transport id/i.test(again) && /Remount succeeded|already|as RW/i.test(again),
    again.slice(0, 100)
  );
}

// --- hot-plug -----------------------------------------------------------
// Opt-in, because `adb reconnect` is not reliably reversible. It is the standard
// way to make a device drop and re-attach, and it does exercise exactly the path
// this feature added — but on the custom ROM tested here the device did not come
// back, and no amount of `adb reconnect offline` / `adb usb` / kill-server
// recovered it. A physical replug was needed. That is too destructive to run by
// default on someone's working hardware.
//
//   HOTPLUG=1 node scripts/verify-root-reconnect.mjs
if (!process.env.HOTPLUG) {
  console.log(
    "\nSKIP  hot-plug reconnect — set HOTPLUG=1 to run it (may require replugging the device afterwards)"
  );
} else {
await dismissAll();
const beforeReconnect = await p.evaluate(() => document.body.innerText);
check("connected before the drop", /ANDROID\s+\d/i.test(beforeReconnect));
try {
  execSync("adb reconnect", { stdio: "pipe" });
} catch {
  /* some builds print to stderr and still work */
}
const recovered = await p
  .waitForFunction(
    () => {
      const t = document.body.innerText;
      // Back to a device page, not merely a list entry.
      return /ANDROID\s+\d/i.test(t) && !/未连接设备/.test(t);
    },
    { timeout: 90000, polling: 1000 }
  )
  .then(() => true)
  .catch(() => false);
check("reconnected on its own after the device dropped", recovered, "no manual refresh");

// And it must be a live connection, not a stale-looking page.
const liveAfter = await newToastAfter("remount");
check(
  "device is actually usable after the auto-reconnect",
  !/transport id/i.test(liveAfter) && /Remount succeeded|already|as RW/i.test(liveAfter),
  liveAfter.slice(0, 100)
);

}

check("toasts render in the top-right", await p.evaluate(() => {
  const el = document.querySelector(".toasts");
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight / 2 && r.right > window.innerWidth / 2;
}));

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
console.log("   toasts:", (await toastText()).slice(0, 160));

await b.close();
console.log(fail ? `\n${fail} FAILED` : "\nROOT/REMOUNT KEEPS A WORKING CONNECTION");
process.exit(fail ? 1 : 0);
