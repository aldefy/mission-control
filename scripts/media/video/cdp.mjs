// Minimal Chrome DevTools Protocol helper: launch headless Chrome, connect, send commands, listen to events.
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function launch({ port = 9340, width = 1920, height = 1080 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "brag-chrome-"))
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--force-device-scale-factor=1", "--disable-gpu-vsync", "--force-color-profile=srgb", "about:blank",
  ], { stdio: "ignore" })
  let wsUrl
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(100)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl
    } catch {}
  }
  if (!wsUrl) throw new Error("chrome did not start")
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map()
  const handlers = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    } else if (msg.method) (handlers.get(msg.method) || []).forEach((h) => h(msg.params))
  }
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  const on = (method, h) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(h) }
  const off = (method) => handlers.delete(method)
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const goto = async (url) => {
    const cur = await evaluate("location.href").catch(() => "")
    if (cur.split("#")[0] === url.split("#")[0] && url.includes("#")) { await evaluate(`location.hash = ${JSON.stringify("#" + url.split("#")[1])}`); return }
    const loaded = new Promise((r) => { const h = () => { off("Page.loadEventFired"); r() }; on("Page.loadEventFired", h) })
    await send("Page.navigate", { url })
    await loaded
  }
  const close = async () => { try { await send("Browser.close") } catch {} ; proc.kill() }
  process.on("exit", () => { try { proc.kill() } catch {} })
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { proc.kill() } catch {} ; process.exit(1) })
  return { send, on, off, evaluate, goto, close, proc }
}
