// Drives the real mission-control demo app in headless Chrome and records it with the CDP screencast.
// Usage: MEDIA_OUT=<dir> DEMO_URL=http://localhost:4570/ node director.mjs   (the demo from ../stage-demo.mjs)
// Output: <out>/frames/*.jpg, <out>/frames.json ({frames:[{f,t}], cuts:[[t0,t1]], marks:[{name,t}], leaks:[]})
// Then: MEDIA_OUT=<dir> node assemble.mjs render  ->  <out>/raw.mp4
// Scenes are the v2.5 walkthrough: edit the "scenes" half below when a release adds or changes a feature.
import { launch, sleep } from "./cdp.mjs"
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const B = process.env.DEMO_URL || "http://localhost:4570/"
const out = process.env.MEDIA_OUT || join(here, "out")
const RUN = "#/item/native/20261102-1000-tip-calculator"
const SESS = "#/item/claude-code/sess-search-ui"
const FORBIDDEN = /my-harness|myequal|brewmate|mycityhub|observer-sessions|reel-brain|\/Users\/|\badit\b|claude-501|\/private\/tmp/i
const OVERLAY = readFileSync(join(here, "overlay.js"), "utf8")
const MOCK = readFileSync(join(here, "mock.js"), "utf8")

const framesDir = join(out, "frames")
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })

const c = await launch()
const ev = (s) => c.evaluate(s)
const now = () => Date.now() / 1000
const frames = [], cuts = [], marks = [], leaks = []
let recording = false

// ---------- page helpers ----------
async function prep() {
  await ev(`document.documentElement.style.zoom = "1.25"; document.documentElement.style.overflow = "hidden"`)
  // CSS zoom scales 100vh too, so h-screen would be 1.25x the window: size the app root to the real 1536x864 window.
  await ev(`(()=>{ const st=document.createElement('style'); st.id='bo-vh'; st.textContent='.h-screen{height:calc(100vh / 1.25) !important}'; document.head.appendChild(st) })()`)
  await ev(OVERLAY)
}
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await ev(`!!(${expr})`).catch(() => false)) return true
    await sleep(80)
  }
  console.warn("waitFor timed out:", expr)
  return false
}
async function leakCheck(label) {
  const txt = await ev(`document.body.innerText`)
  if (FORBIDDEN.test(txt)) { leaks.push(label); console.error("LEAK in", label, txt.match(FORBIDDEN)[0]) }
}
async function scrollTop() {
  await ev(`window.scrollTo(0,0); document.querySelectorAll('*').forEach(e=>{ if(e.scrollTop && !e.closest('[role=listbox]')) e.scrollTop=0 })`)
}
async function nav(hash, readyExpr) {
  await ev(`location.hash = ${JSON.stringify(hash)}`)
  await waitFor(readyExpr || "document.querySelector('main') || document.body")
  await sleep(900)
  await scrollTop()
  await leakCheck(hash)
}
// Cover the screen, do work, cut that span from the timeline, uncover.
async function cutTo(fn) {
  await ev(`BO.cover(true, 160)`)
  await sleep(180)
  const t0 = now()
  await fn()
  await sleep(650)
  const t1 = now()
  cuts.push([t0, t1])
  await ev(`BO.cover(false, 220)`)
  await sleep(140)
}
const mark = (name) => { marks.push({ name, t: now() }); console.log("scene", name) }

// ---------- cursor + input ----------
let cx = 1500, cy = 700
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
async function moveTo(x, y, ms = 650) {
  const x0 = cx, y0 = cy
  const t0 = Date.now()
  for (;;) {
    const p = Math.min(1, (Date.now() - t0) / ms)
    const e = ease(p)
    cx = x0 + (x - x0) * e
    cy = y0 + (y - y0) * e
    await ev(`BO.cursor(${cx},${cy})`)
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy })
    if (p >= 1) break
    await sleep(14)
  }
}
async function click(x, y, ms = 650) {
  await moveTo(x, y, ms)
  await sleep(90)
  await ev(`BO.down(true)`)
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await sleep(90)
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  await ev(`BO.down(false); BO.ripple(${x},${y})`)
}
let camUntil = 0
async function rect(expr) {
  const wait = camUntil - Date.now()
  if (wait > 0) await sleep(wait + 60)
  return ev(`(()=>{ const r = BO.rect(${expr}); return r })()`)
}
async function clickEl(expr, ms) {
  const r = await rect(expr)
  if (!r) { console.warn("no element", expr); return null }
  await click(r.cx, r.cy, ms)
  return r
}
async function hoverEl(expr, ms) {
  const r = await rect(expr)
  if (!r) { console.warn("no element", expr); return null }
  await moveTo(r.cx, r.cy, ms)
  return r
}
const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9 }
async function key(k, modifiers = 0) {
  const code = k.length === 1 ? "Key" + k.toUpperCase() : k
  const vk = KEYS[k] ?? k.toUpperCase().charCodeAt(0)
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await sleep(40)
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}
async function type(str, per = 110) {
  for (const ch of str) {
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch, code: "Key" + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key" + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await sleep(per)
  }
}
const T = (s) => JSON.stringify(s)
const byText = (t, sel = "*", exact = true) => `BO.byText(${T(t)}, ${T(sel)}, ${exact})`
const cap = (num, kicker, line, opts = {}) => ev(`BO.caption(${T(num)}, ${T(kicker)}, ${T(line)}, ${T(opts)})`)
const cam = (s, x, y, ms = 900) => { camUntil = Date.now() + ms; return ev(`BO.camera(${s}, ${x}, ${y}, ${ms})`) }

// ---------- start ----------
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK })
await c.send("Browser.grantPermissions", { origin: B.replace(/\/$/, ""), permissions: ["notifications"] }).catch((e) => console.warn("grant", e.message))
await c.goto(B + "#/")
await waitFor(`document.body.innerText.includes("Needs you") && document.body.innerText.includes("Live now")`)
await prep()
await sleep(1200)
await leakCheck("home")

// Home is pre-staged for the hook: dim + headline words hidden.
await ev(`BO.dim(true); BO.head('<div class="hl"><span class="w">Your</span> <span class="w">agents</span> <span class="w">are</span> <span class="w">busy.</span></div><div class="hl" id="l2"></div>')`)
await ev(`BO.cursor(${cx},${cy}); BO.cursorHide(true)`)
await sleep(300)

c.on("Page.screencastFrame", (p) => {
  c.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {})
  if (!recording) return
  const f = `f${String(frames.length).padStart(5, "0")}.jpg`
  frames.push({ f, t: p.metadata.timestamp })
  writeFileSync(join(framesDir, f), Buffer.from(p.data, "base64"))
})
await c.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
recording = true
const tStart = now()
const hb = setInterval(() => console.log("  t", (now() - tStart).toFixed(1), "frames", frames.length), 5000)

// ---------- camera helpers (regions in device px at camera 1) ----------
async function settle() { const w = camUntil - Date.now(); if (w > 0) await sleep(w + 40) }
// Move the camera to a region and, at the same time, glide the cursor to an element (planned in final camera space).
async function camGo(region, expr, ms = 850, { click: doClick = false, dx = 0, dy = 0, cursorMs } = {}) {
  await settle()
  const raw = expr ? await ev(`BO.rawRect(${expr})`) : null
  if (expr && !raw) console.warn("camGo: no element", expr)
  let cp
  if (region === "el" && raw) cp = await ev(`BO.camRegion(${raw.x},${raw.y},${raw.x + raw.width},${raw.y + raw.height},1.5,${ms})`)
  else if (Array.isArray(region)) cp = await ev(`BO.camRegion(${region.join(",")},${ms})`)
  else if (region === 1) cp = await ev(`BO.camera(1,960,540,${ms})`)
  else cp = await ev(`BO.cam`)
  camUntil = Date.now() + ms
  if (!raw) return
  const tx = cp.fx + (raw.cx - cp.fx) * cp.s + dx, ty = cp.fy + (raw.cy - cp.fy) * cp.s + dy
  await moveTo(tx, ty, cursorMs ?? ms)
  if (doClick) { await settle(); await click(tx, ty, 120) }
}
const tabBtn = (label) => `[...document.querySelectorAll('[role=tab]')].find(e=>e.textContent.trim().startsWith(${T(label)}))`
const inMain = (pred) => `[...document.querySelectorAll('main *')].find(e=>${pred})`
const AMB = "#f59e0b", GRN = "#22c55e", RED = "#ef4444", BLU = "#38bdf8", VIO = "#a78bfa", TEAL = "#2dd4bf", PINK = "#f472b6"

// ===== scenes for v2.5 (appended to head.mjs by build.sh) =====
const sideSwitch = (label) => `[...document.querySelectorAll('[role=switch]')].find(e=>e.textContent.trim().startsWith(${T(label)}))`
const mainBtn = (label) => `[...document.querySelectorAll('main button')].find(e=>e.textContent.trim()===${T(label)})`
const rowOf = (title) => `[...document.querySelectorAll('main table tbody tr')].find(r=>r.querySelector('a')?.textContent.trim()===${T(title)})`
const rowAct = (title, label) => `(${rowOf(title)})?.querySelector('[aria-label^=${T(label)}]')`
// Element inside the phone frame's page, in device px (the frame sits in the overlay root, net zoom 1).
const inPhone = (fn) => `(()=>{ const f=document.getElementById('bo-phone'); if(!f||!f.contentDocument) return null; const el=(${fn})(f.contentDocument); if(!el) return null; const r=f.getBoundingClientRect(), q=el.getBoundingClientRect(), z=${1 / 1.25}; return { cx:(r.x+(q.x+q.width/2))*1, cy:(r.y+(q.y+q.height/2))*1, z } })()`
const banner = (title, body, foot) => `(()=>{ let n=document.getElementById('bo-note'); if(!n){ n=document.createElement('div'); n.id='bo-note'; document.getElementById('bo-root').appendChild(n) }
  n.style.cssText='position:absolute;right:34px;top:34px;width:620px;padding:22px 26px;border-radius:26px;background:rgba(38,38,42,.82);backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px) saturate(1.6);border:1px solid rgba(255,255,255,.14);box-shadow:0 26px 70px rgba(0,0,0,.55);display:flex;gap:18px;align-items:flex-start;z-index:25;opacity:0;transform:translateX(60px);transition:opacity .35s ease,transform .55s cubic-bezier(.2,.8,.2,1)';
  n.innerHTML='<span class="bo-mark" style="flex:none;width:52px;height:52px;border-width:6px;margin-top:2px"><span style="width:16px;height:16px"></span></span><div style="min-width:0;flex:1"><div style="display:flex;justify-content:space-between;font:600 21px -apple-system,system-ui;color:#fafafa"><span>'+${T(title)}+'</span><span style="font-weight:500;color:#a1a1aa;font-size:18px">now</span></div><div style="margin-top:6px;font:500 21px/1.35 -apple-system,system-ui;color:#e4e4e7">'+${T(body)}+'</div><div style="margin-top:4px;font:500 19px -apple-system,system-ui;color:#a1a1aa">'+${T(foot)}+'</div></div>';
  requestAnimationFrame(()=>{ n.style.opacity='1'; n.style.transform='none' }) })()`
const bannerOff = `(()=>{ const n=document.getElementById('bo-note'); if(n){ n.style.opacity='0'; n.style.transform='translateX(60px)' } })()`
const YEL = AMB, CYAN = BLU

// ===== 1. HOOK =====
mark("hook")
await sleep(120)
await ev(`BO.headWords(100)`)
await sleep(800)
await ev(`document.getElementById('l2').innerHTML = '<span class="w amb">3</span> <span class="w">of</span> <span class="w">them</span> <span class="w amb">need</span> <span class="w amb">you.</span>'; BO.headWords(100)`)
await sleep(1650)
await ev(`BO.headOut(); setTimeout(()=>BO.dim(false), 170)`)
const chip = await rect(`[...document.querySelectorAll('header button')].find(e=>/^Needs you/.test(e.textContent.trim()))`)
await sleep(250)
await ev(`BO.ring(${T(chip)}, true, 7)`)
await sleep(520)

// ===== 2. REVEAL =====
mark("reveal")
await ev(`BO.ring(null,false); BO.card('<div style="position:relative;text-align:center">'
 + '<div class="bo-in" style="display:flex;align-items:center;justify-content:center;gap:34px"><span class="bo-mark" style="width:92px;height:92px;border-width:9px"><span style="width:28px;height:28px"></span></span><span style="font-weight:750;font-size:132px;letter-spacing:-.04em;color:#fafafa">mission control</span><span style="align-self:flex-start;margin-top:22px;padding:6px 16px;border-radius:999px;border:1px solid rgba(34,197,94,.5);font:700 30px SF Mono,ui-monospace,monospace;color:#22c55e">2.5</span></div>'
 + '<div class="bo-in" style="margin-top:34px;font-size:50px;font-weight:500;color:#a1a1aa;letter-spacing:-.01em">Every Claude Code and Codex session on your Mac, in one place.</div>'
 + '<div class="bo-in" style="margin-top:46px;display:inline-block;padding:16px 30px;border-radius:14px;border:1px solid #27272a;background:#111113;font:600 34px SF Mono,ui-monospace,monospace;color:#e4e4e7"><span style="color:#22c55e">$</span> npx @aldefy/mission-control</div>'
 + '</div>'); setTimeout(()=>BO.cardIn(220), 180)`)
await sleep(3400)

// ===== 3. NEEDS YOU =====
mark("needs")
await ev(`BO.head(''); BO.camRegion(0, 90, 1010, 760, 1.5, 0)`)
await ev(`BO.cardOff()`)
await sleep(250)
await moveTo(1300, 900, 10)
await ev(`BO.cursorHide(false)`)
await cap("01", "Needs you", "Everything waiting on <b style='color:#f59e0b'>you</b>, with the exact command", { acc: AMB, pos: "r" })
{
  await camGo(null, inMain(`e.textContent.trim()==="Rotate staging keys" && e.getBoundingClientRect().x < 800`), 750, { dy: 26 })
  await sleep(1500)
  await cap("01", "Needs you", "One chip per state. Click one to filter.", { acc: AMB, pos: "r" })
  await camGo([200, 0, 1500, 70, 1.5], `[...document.querySelectorAll('header button')].find(e=>/^Closed/.test(e.textContent.trim()))`, 800)
  await sleep(500)
  for (const k of ["Ready", "Working", "Closed"]) { await hoverEl(`[...document.querySelectorAll('header button')].find(e=>/^${k}/.test(e.textContent.trim()))`, 330); await sleep(330) }
  await sleep(350)
}

// ===== 4. OPEN / CLOSED =====
await cutTo(async () => {
  await ev(`BO.camera(1,960,540,0)`)
  await ev(`(()=>{ const r=[...document.querySelectorAll('main *')].find(e=>e.textContent.trim()==="Recent"); r?.scrollIntoView({block:'start'}) })()`)
  await sleep(300)
  const rc = await ev(`BO.rawRect([...document.querySelectorAll('main *')].find(e=>e.textContent.trim()==="Recent"))`)
  if (rc) await ev(`BO.camRegion(560, ${Math.max(0, rc.y - 20)}, 1910, ${Math.min(1080, rc.y + 640)}, 1.35, 0)`)
  await moveTo(1500, 900, 10)
  await cap("02", "Sessions", "Open or closed, straight from Claude Code", { acc: GRN, pos: "l" })
})
mark("sessions")
{
  await camGo(null, mainBtn("open only"), 600, { click: true })
  await sleep(1100)
  await camGo(null, mainBtn("closed"), 380, { click: true })
  await sleep(1000)
  await camGo(null, mainBtn("all"), 380, { click: true })
  await sleep(500)
  await cap("02", "Sessions", "Rename, pin, archive, or copy the resume command", { acc: GRN, pos: "l" })
  await hoverEl(`${rowOf("Fix flaky onboarding test")}?.querySelector('a')`, 500)
  await sleep(700)
  for (const l of ["Rename", "Copy resume", "Pin to the top"]) { await hoverEl(rowAct("Fix flaky onboarding test", l), 260); await sleep(300) }
  await clickEl(rowAct("Fix flaky onboarding test", "Pin to the top"), 120)
  await sleep(1300)
}

// ===== 5. SESSION PAGE =====
await cutTo(async () => {
  await ev(`BO.camera(1,960,540,0)`)
  await nav(SESS + "/lanes", `document.body.innerText.includes("keyboard navigation")`)
  await cap("03", "Session", "Claude's recap of where you left off", { acc: CYAN, pos: "r" })
  await ev(`BO.camRegion(340, 80, 1910, 330, 1.3, 0)`)
  await moveTo(1300, 700, 10)
})
mark("session")
{
  await hoverEl(inMain(`/keyboard navigation/.test(e.textContent) && e.children.length===0`), 650)
  await sleep(1300)
  await cap("03", "Session", "Name it anything", { acc: CYAN, pos: "r" })
  await camGo(null, `document.querySelector('main button[aria-label="Rename"]')`, 450, { click: true })
  await sleep(300)
  await ev(`(()=>{ const i=document.querySelector('main input'); i?.focus(); i?.select() })()`)
  await type("Search: keyboard nav", 70)
  await sleep(250)
  // Save by clicking: a raw Enter key event goes to Chrome's own UI and backgrounds the page.
  await clickEl(`[...document.querySelectorAll('main button')].find(e=>e.textContent.trim()==="Save")`, 380)
  await sleep(900)
  await cap("03", "Session", "Copy the command that resumes it", { acc: CYAN, pos: "r" })
  await hoverEl(`[...document.querySelectorAll('main button')].find(e=>/copy resume/i.test(e.textContent))`, 500)
  await sleep(1200)
  await cap("03", "Session", "One card per agent, live", { acc: GRN, pos: "r" })
  await camGo([340, 260, 1910, 1060, 1.2], `document.querySelector('[aria-label="Flow"]')`, 800, { dy: 40 })
  await sleep(1300)
}

// ===== 6. USAGE =====
await cutTo(async () => {
  await ev(`BO.camera(1,960,540,0)`)
  await nav("#/usage", `document.body.innerText.includes("Total tokens")`)
  await cap("04", "Usage", "Tokens and est. cost, every day", { acc: VIO, pos: "r" })
  await ev(`BO.camRegion(280, 100, 1910, 590, 1.3, 0)`)
  await moveTo(800, 760, 10)
})
mark("usage")
{
  await camGo(null, inMain(`e.textContent.trim()==="Total tokens" && e.getBoundingClientRect().y > 150`), 600, { dy: 30 })
  await sleep(900)
  await camGo(1, null, 550)
  await ev(`(()=>{ const st=document.createElement('style'); st.id='bo-pad'; st.textContent='main{padding-bottom:900px !important}'; document.head.appendChild(st); [...document.querySelectorAll('main *')].find(e=>e.textContent.trim()==="Breakdown").closest('section,div[class*="rounded"]').scrollIntoView({behavior:'smooth', block:'start'}) })()`)
  await sleep(700)
  await cap("04", "Usage", "By project and by worktree", { acc: VIO, pos: "r" })
  const tab = (label) => `[...document.querySelectorAll('main button, main [role=tab], main [role=radio]')].find(e=>e.textContent.trim()===${T(label)})`
  await clickEl(tab("Projects"), 500)
  await sleep(600)
  await clickEl(tab("Worktrees"), 350)
  await sleep(900)
}

// ===== 7. TOUR =====
await cutTo(async () => {
  await ev(`BO.camera(1,960,540,0)`)
  await ev(`document.getElementById('bo-pad')?.remove()`)
  await nav("#/", `document.body.innerText.includes("Live now")`)
  await cap("05", "Tour", "New here? A one-minute tour over your own sessions", { acc: GRN, pos: "l" })
  await moveTo(1300, 500, 10)
})
mark("tour")
{
  await clickEl(`document.querySelector('button[aria-label="Take the tour"]')`, 650)
  await sleep(1700)
  await clickEl(`[...document.querySelectorAll('[role=dialog] button')].find(e=>/^(Start|Next)$/.test(e.textContent.trim()))`, 500)
  await sleep(1600)
  await clickEl(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==="Next")`, 420)
  await sleep(1500)
  await key("Escape")
  await sleep(250)
}

// ===== 8. NOTIFICATIONS =====
mark("notify")
await cap("06", "Notifications", "Off until you turn them on", { acc: AMB, pos: "r" })
{
  const top = await ev(`BO.rawRect([...document.querySelectorAll('*')].find(e=>e.textContent.trim()==="Notifications" && e.children.length===0))`)
  const y0 = top ? top.y - 30 : 560
  await camGo([0, y0, 820, Math.min(1080, y0 + 470), 1.6], null, 850)
  await settle()
  await clickEl(sideSwitch("Needs you"), 650)
  await sleep(550)
  await clickEl(sideSwitch("Done"), 380)
  await sleep(450)
  await hoverEl(`[...document.querySelectorAll('aside *, [data-sidebar] *')].find(e=>e.textContent.trim()==="allowed" && e.children.length===0)`, 400)
  await sleep(800)
  await cap("06", "Notifications", "One alert, in one place: this tab, your phone, or macOS", { acc: AMB, pos: "r", maxw: 1000 })
  await camGo(1, null, 700)
  await moveTo(1150, 620, 500)
  await sleep(250)
  await ev(banner("Rotate staging keys", "Needs you · ./scripts/rotate-keys.sh staging", "Claude Code · api · main"))
  await sleep(2600)
  await ev(bannerOff)
}

// ===== 9. SETTINGS =====
mark("settings")
await cap("07", "Settings", "Keep sessions longer. It asks before it writes.", { acc: CYAN, pos: "r" })
{
  const top = await ev(`BO.rawRect([...document.querySelectorAll('*')].find(e=>e.textContent.trim()==="History" && e.children.length===0))`)
  const y0 = top ? top.y - 30 : 760
  await camGo([0, y0, 820, Math.min(1080, y0 + 300), 1.7], null, 800)
  await settle()
  await clickEl(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==="60")`, 600)
  await sleep(2000)
  await clickEl(`[...document.querySelectorAll('[role=group][aria-label="Confirm Keep sessions"] button')].find(e=>e.textContent.trim()==="cancel")`, 420)
  await sleep(500)
  await cap("07", "Settings", "Start at login", { acc: CYAN, pos: "r" })
  await clickEl(sideSwitch("Start at login"), 450)
  await sleep(1400)
}

// ===== 10. PHONE =====
mark("phone")
await ev(`BO.captionOff(); BO.cursorHide(true); BO.cover(true, 220)`)
await sleep(260)
await ev(`BO.camera(1,960,540,0); BO.card('<div style="position:relative;display:flex;align-items:center;gap:110px">'
 + '<div style="width:760px;text-align:left">'
 + '<div class="bo-in" style="font:600 22px SF Mono,ui-monospace,monospace;letter-spacing:.12em;color:#a1a1aa;text-transform:uppercase;display:flex;gap:12px;align-items:center"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#f59e0b;box-shadow:0 0 12px #f59e0b"></i><b style="color:#f59e0b">08</b> Remote</div>'
 + '<div class="bo-in" style="margin-top:22px;font-weight:750;font-size:84px;line-height:1.02;letter-spacing:-.035em;color:#fafafa">Answer from your phone.</div>'
 + '<div class="bo-in" style="margin-top:30px;font-size:38px;line-height:1.3;font-weight:500;color:#a1a1aa">Pair once over Tailscale. Allow, deny, or pick an answer. <span style="color:#e4e4e7">No cloud.</span></div>'
 + '</div>'
 + '<div class="bo-in" style="width:426px;height:900px;border-radius:64px;padding:16px;background:#1c1c1f;border:2px solid #3f3f46;box-shadow:0 50px 140px rgba(0,0,0,.7),inset 0 0 0 6px #0b0b0d;position:relative">'
 + '<div style="position:absolute;top:28px;left:50%;transform:translateX(-50%);width:120px;height:34px;border-radius:20px;background:#000;z-index:2"></div>'
 + '<iframe id="bo-phone" src="/remote.html" style="width:390px;height:864px;border:0;border-radius:50px;background:#09090b;display:block"></iframe>'
 + '</div></div>'); setTimeout(()=>BO.cover(false, 280), 240); setTimeout(()=>BO.cardIn(180), 300)`)
// Leave the frame alone while it loads: touching its blank document first makes Chrome reuse that window for
// remote.html, and the init-script mock never installs.
await sleep(1500)
await waitFor(inPhone(`(d)=>[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==="Allow")`), 8000)
await leakCheck("phone")
await sleep(1600)
{
  await moveTo(1500, 980, 10)
  await ev(`BO.cursorHide(false)`)
  const allow = await ev(inPhone(`(d)=>[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==="Allow")`))
  if (allow) { await click(allow.cx, allow.cy, 700) } else console.warn("no Allow in phone")
  await sleep(2400)
  const opt = await ev(inPhone(`(d)=>[...d.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith("Last 5 searches"))`))
  if (opt) { await click(opt.cx, opt.cy, 550) } else console.warn("no option in phone")
  await sleep(2600)
}

// ===== 11. GET IT =====
mark("getit")
await ev(`BO.cursorHide(true); BO.cover(true, 220)`)
await sleep(260)
await ev(`BO.card('<div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:40px">'
 + '<div class="bo-in" style="font-weight:750;font-size:76px;letter-spacing:-.03em;color:#fafafa">Zero setup for Claude Code.</div>'
 + '<div class="bo-in term"><div class="bar"><i></i><i></i><i></i><span>~/code</span></div><div class="body">'
 + '<div class="row"><span class="lvl">try it</span><div><div class="cmd" data-type="<span class=p>$</span> npx @aldefy/mission-control"></div><div class="out">Every session shows up, <b>subagents as lanes.</b></div></div></div>'
 + '<div class="row" style="margin-bottom:0"><span class="lvl">phone</span><div><div class="cmd" data-type="<span class=p>$</span> mission-control remote setup"></div><div class="out">Pairs your phone. <b style=color:#f59e0b>Needs you</b> buzzes it.</div></div></div>'
 + '</div></div></div>'); setTimeout(()=>BO.cover(false, 280), 240); setTimeout(()=>BO.cardIn(160), 300)`)
await sleep(800)
for (let i = 0; i < 2; i++) {
  await ev(`(()=>{ const el=document.querySelectorAll('#bo-card .cmd')[${i}]; const full=el.dataset.type; const tmp=document.createElement('div'); tmp.innerHTML=full; const plain=tmp.textContent; let n=0;
    const step=()=>{ n++; const t=document.createElement('div'); t.innerHTML=full; let left=n; const walk=(node)=>{ for(const ch of [...node.childNodes]){ if(ch.nodeType===3){ if(left<=0){ch.remove();continue} if(ch.textContent.length>left){ch.textContent=ch.textContent.slice(0,left)} left-=ch.textContent.length } else walk(ch) } }; walk(t); el.innerHTML=t.innerHTML+'<span class=caret></span>'; if(n<plain.length) setTimeout(step, 26); else setTimeout(()=>{ el.innerHTML=full; el.parentElement.querySelector('.out').classList.add('shown') }, 150) }; step() })()`)
  await sleep(i === 0 ? 1500 : 1700)
}
await sleep(1300)

// ===== 12. OUTRO =====
mark("outro")
await ev(`BO.cover(true, 260)`)
await sleep(280)
await ev(`BO.card('<div style="position:relative;text-align:center">'
 + '<div class="bo-in" style="display:flex;align-items:center;justify-content:center;gap:30px"><span class="bo-mark" style="width:80px;height:80px;border-width:8px"><span style="width:24px;height:24px"></span></span><span style="font-weight:750;font-size:116px;letter-spacing:-.04em;color:#fafafa">mission control</span></div>'
 + '<div class="bo-in" style="margin-top:30px;font-size:48px;font-weight:550;color:#e4e4e7;letter-spacing:-.01em">Local. No account. Open source.</div>'
 + '<div class="bo-in" style="margin-top:46px;display:inline-flex;gap:22px">'
 + '<span style="padding:16px 30px;border-radius:14px;border:1px solid #27272a;background:#111113;font:600 32px SF Mono,ui-monospace,monospace;color:#22c55e">github.com/aldefy/mission-control</span>'
 + '<span style="padding:16px 30px;border-radius:14px;border:1px solid #27272a;background:#111113;font:600 32px SF Mono,ui-monospace,monospace;color:#e4e4e7">npm · @aldefy/mission-control</span></div>'
 + '</div>'); BO.cover(false, 300); setTimeout(()=>BO.cardIn(220), 100)`)
await sleep(3200)

recording = false
clearInterval(hb)
await c.send("Page.stopScreencast")
await leakCheck("end")
writeFileSync(join(out, "frames.json"), JSON.stringify({ tStart, frames, cuts, marks, leaks }, null, 0))
console.log("frames", frames.length, "cuts", cuts.length, "leaks", leaks.length, "raw secs", (now() - tStart).toFixed(1))
await c.close()
process.exit(0)
