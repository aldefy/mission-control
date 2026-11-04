// node scripts/media/shots.mjs <out-dir> [demo-url]
// Screenshots of the staged demo (scripts/media/stage-demo.mjs) at 1440x900, as PNG: the README's
// docs/screenshots set and the website's set come from these. Fails if any page shows a real name or path.
import { launch, sleep } from "./video/cdp.mjs"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = process.argv[2]
if (!out) { console.error("usage: node scripts/media/shots.mjs <out-dir> [demo-url]"); process.exit(2) }
const B = process.argv[3] || "http://localhost:4570/"
// Anything from the machine the shots are taken on. Add your own project names here if they could appear.
const FORBIDDEN = new RegExp(process.env.MEDIA_FORBIDDEN || "\\/Users\\/|\\/home\\/[a-z]|claude-501|\\/private\\/tmp|\\/var\\/folders", "i")
mkdirSync(out, { recursive: true })

const items = await (await fetch(B + "api/items")).json()
const apiKey = items.find((i) => i.project?.name === "api")?.project.key
const SHOTS = [
  ["home", "#/", `document.body.innerText.includes("Live now")`],
  ["run-lanes", "#/item/native/20261102-1000-tip-calculator/lanes", `document.querySelector('[aria-label="Flow"]')`],
  ["run-map", "#/item/native/20261102-1000-tip-calculator/map", `document.querySelector('[aria-label="Crew map"]')`],
  ["calls", "#/item/claude-code/sess-search-ui/calls", `document.querySelector('[aria-label="Calls"]')`],
  ["timeline", "#/item/claude-code/sess-api-live/timeline", `document.querySelector('button[aria-label="Zoom in"]')`],
  ["usage", "#/usage", `document.body.innerText.includes("Total tokens")`],
  ["project", `#/project/${apiKey}`, `document.body.innerText.includes("Rotate staging keys")`],
  ["turns", "#/item/claude-code/sess-api-live/turns", `document.querySelector('main table')`],
  ["session", "#/item/claude-code/sess-search-ui/lanes", `document.body.innerText.includes("keyboard navigation")`],
]
const c = await launch({ port: 9346, width: 1440, height: 900 })
// The sidebar settings as a normal install shows them (the demo's stand-in home hides Start at login).
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "video", "mock.js"), "utf8") })
await c.goto(B + "#/")
await sleep(2500)
const leaks = []
for (const [name, hash, ready] of SHOTS) {
  await c.evaluate(`location.hash = ${JSON.stringify(hash)}`)
  const t0 = Date.now()
  while (Date.now() - t0 < 8000 && !(await c.evaluate(`!!(${ready})`).catch(() => false))) await sleep(100)
  await sleep(2200)
  await c.evaluate(`window.scrollTo(0,0); document.querySelectorAll('*').forEach(e=>{ if(e.scrollTop) e.scrollTop=0 }); document.activeElement?.blur?.()`)
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1430, y: 890 })
  await sleep(500)
  const txt = await c.evaluate(`document.body.innerText`)
  if (FORBIDDEN.test(txt)) leaks.push(`${name}: ${txt.match(FORBIDDEN)[0]}`)
  const { data } = await c.send("Page.captureScreenshot", { format: "png" })
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"))
  console.log("shot", name)
}
await c.close()
if (leaks.length) { console.error("LEAKS (do not publish):", leaks.join("; ")); process.exit(1) }
console.log("no leaks")
process.exit(0)
