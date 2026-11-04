// In-page overlay for the brag video: cursor, click ripples, captions, headline, title cards, dip transitions, camera.
// Coordinates are device pixels (1920×1080). The page runs at html zoom Z; the overlay root cancels it.
(() => {
  if (window.BO) return
  const Z = 1.25
  const css = `
  #bo-root{position:fixed;inset:0;zoom:${1 / Z};pointer-events:none;z-index:2147483646;font-family:-apple-system,"SF Pro Display",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  #bo-root *{box-sizing:border-box}
  #bo-cursor{position:absolute;left:0;top:0;width:34px;height:34px;transform:translate(-200px,-200px);transition:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.55));z-index:30}
  #bo-cursor svg{transition:transform .12s ease}
  #bo-cursor.down svg{transform:scale(.82)}
  .bo-ripple{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2.5px solid #fafafa;opacity:.95;animation:bo-rip .55s cubic-bezier(.2,.7,.3,1) forwards;z-index:29}
  @keyframes bo-rip{to{transform:scale(4.2);opacity:0}}
  #bo-cap{position:absolute;left:52px;bottom:52px;max-width:1180px;padding:20px 28px 22px;border-radius:18px;background:rgba(14,14,17,.88);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.4);opacity:0;transform:translateY(18px);transition:opacity .38s ease,transform .5s cubic-bezier(.2,.8,.2,1);z-index:20}
  #bo-cap.on{opacity:1;transform:none}
  #bo-cap.r{left:auto;right:52px}
  #bo-cap.t{bottom:auto;top:96px}
  #bo-cap .k{font:600 18px/1 "SF Mono",ui-monospace,Menlo,monospace;letter-spacing:.12em;color:#a1a1aa;text-transform:uppercase;display:flex;gap:12px;align-items:center}
  #bo-cap .k b{color:var(--bo-acc,#22c55e);font-weight:700}
  #bo-cap .k i{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bo-acc,#22c55e);box-shadow:0 0 12px var(--bo-acc,#22c55e)}
  #bo-cap .l{margin-top:12px;font-weight:650;font-size:40px;line-height:1.12;letter-spacing:-.015em;color:#fafafa;transition:opacity .18s ease}
  #bo-cap .l.swap{opacity:0}
  #bo-dim{position:absolute;inset:0;background:rgba(9,9,11,.66);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);opacity:0;transition:opacity .5s ease;z-index:5}
  #bo-dim.on{opacity:1}
  #bo-head{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;z-index:6;text-align:center}
  #bo-head .hl{font-weight:750;font-size:112px;line-height:1.04;letter-spacing:-.035em;color:#fafafa}
  #bo-head .w{display:inline-block;opacity:0;transform:translateY(28px);filter:blur(6px);transition:opacity .45s ease,transform .6s cubic-bezier(.2,.8,.2,1),filter .45s ease}
  #bo-head .w.on{opacity:1;transform:none;filter:none}
  #bo-head .amb{color:#f59e0b}
  #bo-head .grn{color:#22c55e}
  #bo-card{position:absolute;inset:0;background:#09090b;opacity:0;transition:opacity .22s ease;z-index:10;display:flex;align-items:center;justify-content:center;overflow:hidden}
  #bo-card.on{opacity:1}
  #bo-card .glow{position:absolute;width:1400px;height:900px;left:50%;top:50%;transform:translate(-50%,-50%);background:radial-gradient(closest-side,rgba(34,197,94,.13),rgba(34,197,94,0) 70%);pointer-events:none}
  #bo-card .grid{position:absolute;inset:-2px;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(closest-side,#000 30%,transparent 100%);-webkit-mask-image:radial-gradient(ellipse 60% 60% at 50% 50%,#000 20%,transparent 100%)}
  .bo-in{opacity:0;transform:translateY(26px);transition:opacity .5s ease,transform .7s cubic-bezier(.2,.8,.2,1)}
  .bo-in.on{opacity:1;transform:none}
  .bo-mark{display:inline-grid;place-items:center;border-radius:50%;border:solid #fafafa}
  .bo-mark>span{display:block;border-radius:50%;background:#fafafa}
  #bo-cover{position:absolute;inset:0;background:#09090b;opacity:0;transition:opacity .22s ease;z-index:15}
  #bo-cover.on{opacity:1}
  .bo-ring{position:absolute;border:3px solid #f59e0b;border-radius:14px;box-shadow:0 0 0 6px rgba(245,158,11,.18),0 0 40px rgba(245,158,11,.45);opacity:0;transition:opacity .3s ease;z-index:4}
  .bo-ring.on{opacity:1;animation:bo-pulse 1.1s ease-in-out infinite}
  @keyframes bo-pulse{50%{box-shadow:0 0 0 12px rgba(245,158,11,.06),0 0 60px rgba(245,158,11,.6)}}
  .term{width:1180px;border-radius:20px;background:#111113;border:1px solid #27272a;box-shadow:0 40px 120px rgba(0,0,0,.6);overflow:hidden;text-align:left}
  .term .bar{height:46px;display:flex;align-items:center;gap:9px;padding:0 18px;border-bottom:1px solid #27272a;background:#0c0c0e}
  .term .bar i{width:13px;height:13px;border-radius:50%;background:#3f3f46}
  .term .bar span{margin-left:12px;font:500 17px "SF Mono",ui-monospace,monospace;color:#8a8a93}
  .term .body{padding:26px 34px 30px;font:500 27px/1.5 "SF Mono",ui-monospace,Menlo,monospace;color:#e4e4e7}
  .term .row{display:grid;grid-template-columns:150px 1fr;align-items:baseline;gap:18px;margin:6px 0 20px}
  .term .lvl{font:700 17px "SF Mono",ui-monospace,monospace;letter-spacing:.1em;color:#71717a;text-transform:uppercase}
  .term .cmd{color:#fafafa;white-space:pre}
  .term .cmd .p{color:#22c55e}
  .term .cmd .f{color:#38bdf8}
  .term .out{font:500 25px/1.35 -apple-system,system-ui,sans-serif;color:#a1a1aa;margin-top:6px;opacity:0;transform:translateY(8px);transition:opacity .35s ease,transform .45s cubic-bezier(.2,.8,.2,1)}
  .term .out.shown{opacity:1;transform:none}
  .term .cmd{min-height:40px}
  .term .out b{color:#fafafa;font-weight:650}
  .term .caret{display:inline-block;width:14px;height:30px;background:#fafafa;vertical-align:-5px;animation:bo-blink 1s steps(1) infinite}
  @keyframes bo-blink{50%{opacity:0}}
  `
  const st = document.createElement("style")
  st.id = "bo-style"
  st.textContent = css
  document.head.appendChild(st)
  const root = document.createElement("div")
  root.id = "bo-root"
  root.innerHTML = `<div id="bo-dim"></div><div id="bo-head"></div><div id="bo-card"></div><div id="bo-cover"></div>
  <div id="bo-cap"><div class="k"><i></i><b></b><span></span></div><div class="l"></div></div>
  <div id="bo-cursor"><svg width="34" height="34" viewBox="0 0 34 34"><path d="M7 3.5 L7 27 L12.6 21.6 L16.4 30.2 L20.4 28.4 L16.7 20 L24.4 20 Z" fill="#fff" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/></svg></div>`
  document.body.appendChild(root)
  const $ = (s) => root.querySelector(s)
  const cur = $("#bo-cursor")
  let cx = -200, cy = -200
  const BO = {
    Z,
    cursor(x, y) { cx = x; cy = y; cur.style.transform = `translate(${x - 7}px,${y - 3}px)` },
    cursorHide(h) { cur.style.opacity = h ? "0" : "1" },
    down(d) { cur.classList.toggle("down", d) },
    ripple(x, y, color) {
      const r = document.createElement("div")
      r.className = "bo-ripple"
      r.style.left = x + "px"; r.style.top = y + "px"
      if (color) r.style.borderColor = color
      root.appendChild(r)
      setTimeout(() => r.remove(), 700)
    },
    caption(num, kicker, line, opts = {}) {
      const c = $("#bo-cap")
      c.style.setProperty("--bo-acc", opts.acc || "#22c55e")
      if (opts.maxw) c.style.maxWidth = opts.maxw + "px"; else c.style.maxWidth = ""
      const l = c.querySelector(".l")
      const set = () => { c.querySelector(".k b").textContent = num; c.querySelector(".k span").textContent = kicker; l.innerHTML = line }
      const side = (opts.pos || "l")
      const place = () => { c.classList.toggle("r", side === "r" || side === "tr"); c.classList.toggle("t", side === "tr" || side === "tl"); c.dataset.side = side }
      if (c.classList.contains("on") && c.dataset.side === side) { l.classList.add("swap"); setTimeout(() => { set(); l.classList.remove("swap") }, 200) }
      else if (c.classList.contains("on")) { c.classList.remove("on"); setTimeout(() => { place(); set(); c.classList.add("on") }, 300) }
      else { place(); set(); requestAnimationFrame(() => c.classList.add("on")) }
    },
    captionOff() { $("#bo-cap").classList.remove("on") },
    dim(on) { $("#bo-dim").classList.toggle("on", on) },
    head(html) { $("#bo-head").innerHTML = html },
    headWords(stepMs = 110) {
      const ws = [...root.querySelectorAll("#bo-head .w:not(.on)")]
      ws.forEach((w, i) => setTimeout(() => w.classList.add("on"), i * stepMs))
    },
    headOut() { root.querySelectorAll("#bo-head .w").forEach((w) => { w.style.transition = "opacity .16s ease"; w.classList.remove("on") }) },
    card(html) { const c = $("#bo-card"); c.innerHTML = `<div class="grid"></div><div class="glow"></div>` + html; c.classList.add("on") },
    cardIn(stepMs = 160) { [...root.querySelectorAll("#bo-card .bo-in:not(.on)")].forEach((e, i) => setTimeout(() => e.classList.add("on"), 120 + i * stepMs)) },
    cardOff() { root.querySelectorAll("#bo-card .bo-in").forEach((e) => { e.style.transition = "opacity .18s ease"; e.classList.remove("on") }); setTimeout(() => $("#bo-card").classList.remove("on"), 190) },
    cover(on, ms) { const c = $("#bo-cover"); if (ms) c.style.transitionDuration = ms + "ms"; c.classList.toggle("on", on) },
    ring(rect, on, pad = 8) {
      let r = $(".bo-ring")
      if (!r) { r = document.createElement("div"); r.className = "bo-ring"; root.appendChild(r) }
      if (rect) Object.assign(r.style, { left: rect.x - pad + "px", top: rect.y - pad + "px", width: rect.width + pad * 2 + "px", height: rect.height + pad * 2 + "px" })
      r.classList.toggle("on", on)
    },
    // Camera: scale the app root about a device-pixel point (fx, fy) so that point stays put; ms = transition.
    cam: { s: 1, fx: 960, fy: 540 },
    // Frame a region (device px at camera 1): scale to fit with padding, centred, clamped to the page edges.
    camRegion(x0, y0, x1, y1, maxS = 1.5, ms = 900, pad = 28) {
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
      const s = Math.max(1, Math.min(maxS, 1920 / (x1 - x0), 1080 / (y1 - y0)))
      if (s === 1) return this.camera(1, 960, 540, ms)
      const cxr = (x0 + x1) / 2, cyr = (y0 + y1) / 2
      const clamp = (v, hi) => Math.max(0, Math.min(hi, v))
      const fx = clamp((960 - cxr * s) / (1 - s), 1920), fy = clamp((540 - cyr * s) / (1 - s), 1080)
      return this.camera(s, fx, fy, ms)
    },
    rawRect(sel, i = 0) {
      const r = this.rect(sel, i)
      if (!r) return null
      const { s, fx, fy } = this.cam
      const x = fx + (r.x - fx) / s, y = fy + (r.y - fy) / s, w = r.width / s, h = r.height / s
      return { x, y, width: w, height: h, cx: x + w / 2, cy: y + h / 2 }
    },
    camera(scale = 1, fx = 960, fy = 540, ms = 900) {
      this.cam = { s: scale, fx, fy }
      const app = document.getElementById("root")
      app.style.transformOrigin = `${fx / Z}px ${fy / Z}px`
      app.style.transition = ms ? `transform ${ms}ms cubic-bezier(.45,.05,.25,1)` : "none"
      app.style.transform = scale === 1 ? "" : `scale(${scale})`
      return this.cam
    },
    rect(sel, i = 0) {
      const el = typeof sel === "string" ? document.querySelectorAll(sel)[i] : sel
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
    },
    byText(text, sel = "*", exact = true) {
      const all = [...document.querySelectorAll(sel)].filter((e) => !root.contains(e))
      const m = all.filter((e) => { const t = (e.textContent || "").trim(); return exact ? t === text : t.includes(text) })
      // innermost match
      return m.filter((e) => !m.some((o) => o !== e && e.contains(o)))[0] || null
    },
  }
  window.BO = BO
})()
