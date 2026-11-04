// MEDIA_OUT=<dir> (the director's output). Map recorded screencast frames onto the output timeline (cut spans removed), then:
//   node assemble.mjs stills t1 t2 ...   -> copies the frame shown at each output time to work/stills/
//   node assemble.mjs render             -> work/raw.mp4 (30 fps, silent)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = process.env.MEDIA_OUT || join(dirname(fileURLToPath(import.meta.url)), "out")
const j = JSON.parse(readFileSync(join(here, "frames.json"), "utf8"))
const { tStart, cuts } = j
const inCut = (t) => cuts.some(([a, b]) => t > a && t < b)
const cutBefore = (t) => cuts.reduce((s, [a, b]) => s + (t >= b ? b - a : t > a ? t - a : 0), 0)
const outT = (t) => t - tStart - cutBefore(t)
const frames = j.frames.filter((f) => !inCut(f.t)).map((f) => ({ ...f, o: outT(f.t) }))
const end = outT(j.marks.at(-1).t) + 3.1 // outro hold
const marks = j.marks.map((m) => ({ name: m.name, o: outT(m.t) }))

const mode = process.argv[2]
if (mode === "info") {
  console.log("duration", end.toFixed(2), "frames", frames.length)
  console.log(marks.map((m) => `${m.name}@${m.o.toFixed(1)}`).join(" "))
}
const at = (o) => { let k = 0; for (let i = 0; i < frames.length; i++) if (frames[i].o <= o) k = i; return frames[k] }
if (mode === "stills") {
  mkdirSync(join(here, "stills"), { recursive: true })
  for (const a of process.argv.slice(3)) {
    const f = at(+a)
    copyFileSync(join(here, "frames", f.f), join(here, "stills", `s_${(+a).toFixed(1).padStart(5, "0")}.jpg`))
  }
}
if (mode === "render") {
  const lines = ["ffconcat version 1.0"]
  for (let i = 0; i < frames.length; i++) {
    const d = (i + 1 < frames.length ? frames[i + 1].o : end) - frames[i].o
    if (d <= 0) continue
    lines.push(`file 'frames/${frames[i].f}'`, `duration ${d.toFixed(5)}`)
  }
  lines.push(`file 'frames/${frames.at(-1).f}'`)
  writeFileSync(join(here, "list.ffconcat"), lines.join("\n"))
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.ffconcat",
    "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation",
    "-an", "-movflags", "+faststart", "-t", end.toFixed(3), "raw.mp4"], { cwd: here, stdio: "inherit" })
  console.log("raw.mp4", end.toFixed(2), "s")
}
