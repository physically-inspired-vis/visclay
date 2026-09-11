import express from 'express'
import multer  from 'multer'
import cors    from 'cors'
import { spawn }   from 'child_process'
import path        from 'path'
import fs          from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Blender executable. Auto-detected per platform; override with the BLENDER_PATH
// env var, e.g. BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender
const BLENDER = process.env.BLENDER_PATH || (
  process.platform === 'darwin' ? '/Applications/Blender.app/Contents/MacOS/Blender' :
  process.platform === 'win32'  ? 'C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe' :
  'blender'   // linux: assume it's on PATH
)
const blenderStartError = err =>
  `Could not start Blender: ${err.message}. Is Blender installed at "${BLENDER}"? Override with the BLENDER_PATH env var.`
const SCRIPTS    = path.join(__dirname, 'scripts')
const JOBS_DIR   = path.join(__dirname, 'jobs')
const MODELS_DIR   = path.join(__dirname, '..', 'src', 'assets', 'models')
const TEXTURES_DIR = path.join(__dirname, '..', 'src', 'assets', 'textures')

if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true })

const app     = express()
const storage = multer.diskStorage({
  destination: JOBS_DIR,
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
})
const upload = multer({ storage })

app.use(cors())
app.use(express.json())
app.use('/models', express.static(MODELS_DIR))

// ── POST /shatter ─────────────────────────────────────────────────────────────
// Body: multipart with field "model" (GLB file) and optional "pieces" (number)
// Returns: animated GLB file

function runBlender(inputPath, outputPath, { pieces, cutSpread, voxelDiv, cutStrategy, adaptivity, fractureMethod, mode }, res) {
  const scriptPath = path.join(SCRIPTS, 'shatter.py')
  const jobId = Date.now().toString()
  console.log(`\n[${jobId}] input=${inputPath}  pieces=${pieces}  spread=${cutSpread}  strategy=${cutStrategy}  mode=${mode ?? 'single'}`)

  const blenderArgs = [
    '--background', '--python', scriptPath,
    '--', inputPath, outputPath,
    (pieces         ?? 10).toString(),
    (cutSpread      ?? 0.5).toString(),
    (voxelDiv       ?? 30).toString(),
    (cutStrategy    ?? 'random'),
    (adaptivity     ?? 0).toString(),
    (fractureMethod ?? 'bisect'),
    (mode           ?? 'single'),
  ]

  const blender = spawn(BLENDER, blenderArgs)

  blender.stdout.on('data', d => process.stdout.write(`  [blender] ${d}`))
  blender.stderr.on('data', d => process.stderr.write(`  [blender] ${d}`))

  // A failed spawn emits BOTH 'error' and 'close'; guard so we respond only once
  // (a second res.json throws ERR_HTTP_HEADERS_SENT and crashes the process).
  let settled = false
  blender.on('close', code => {
    if (settled) return; settled = true
    if (inputPath !== 'SPHERE') fs.unlink(inputPath, () => {})
    if (code !== 0 || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: `Blender failed (exit ${code})` })
    }
    res.download(outputPath, 'shattered.glb', () => fs.unlink(outputPath, () => {}))
  })

  blender.on('error', err => {
    if (settled) return; settled = true
    res.status(500).json({ error: blenderStartError(err) })
  })
}

function paramsFromBody(body) {
  return {
    pieces:          Number(body.pieces)          || 10,
    cutSpread:       Number(body.cutSpread)       || 0.5,
    voxelDiv:        Number(body.voxelDiv)        || 30,
    cutStrategy:     body.cutStrategy             || 'random',
    adaptivity:      Number(body.adaptivity)      || 0,
    fractureMethod:  body.fractureMethod          || 'bisect',
    mode:            body.mode                    || 'single',
  }
}

// ── POST /shatter  (GLB upload) ───────────────────────────────────────────────
app.post('/shatter', upload.single('model'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No model file uploaded' })
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-shattered.glb`)
  runBlender(req.file.path, outputPath, paramsFromBody(req.body), res)
})

// ── GET /shatter/sphere & /shatter/cube  (built-in shapes) ───────────────────
app.get('/shatter/sphere', (req, res) => {
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-shattered.glb`)
  runBlender('SPHERE', outputPath, paramsFromBody(req.query), res)
})

app.get('/shatter/cube', (req, res) => {
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-shattered.glb`)
  runBlender('CUBE', outputPath, paramsFromBody(req.query), res)
})

// ── POST /deform  (GLB upload) ────────────────────────────────────────────────
// Body: multipart with optional "model" file + params: mode, factor, axis, limitMin, limitMax
function runDeform(inputPath, outputPath, params, res) {
  const scriptPath = path.join(SCRIPTS, 'deform.py')
  const { deformMode = 'STRETCH', factor = 1.0, factor2 = 0.5, axis = 'Y', limitMin = 0, limitMax = 1, bendPivot = 0, subdivs = 0 } = params
  console.log(`\n[deform] input=${inputPath} mode=${deformMode} factor=${factor} axis=${axis} pivot=${bendPivot} subdivs=${subdivs}`)

  const blenderArgs = [
    '--background', '--python', scriptPath,
    '--', inputPath, outputPath,
    deformMode, factor.toString(), axis,
    limitMin.toString(), limitMax.toString(),
    factor2.toString(), bendPivot.toString(), subdivs.toString(),
  ]

  const blender = spawn(BLENDER, blenderArgs)
  blender.stdout.on('data', d => process.stdout.write(`  [blender] ${d}`))
  blender.stderr.on('data', d => process.stderr.write(`  [blender] ${d}`))

  let settled = false
  blender.on('close', code => {
    if (settled) return; settled = true
    if (inputPath !== 'SPHERE' && inputPath !== 'CUBE') fs.unlink(inputPath, () => {})
    if (code !== 0 || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: `Blender failed (exit ${code})` })
    }
    res.download(outputPath, 'deformed.glb', () => fs.unlink(outputPath, () => {}))
  })

  blender.on('error', err => {
    if (settled) return; settled = true
    res.status(500).json({ error: blenderStartError(err) })
  })
}

function deformParamsFromQuery(q) {
  return {
    deformMode:  (q.deformMode || 'STRETCH').toUpperCase(),
    factor:      Number(q.factor)     || 1.0,
    factor2:     Number(q.factor2)    || 0.5,
    axis:        (q.axis || 'Y').toUpperCase(),
    limitMin:    Number(q.limitMin)   || 0,
    limitMax:    q.limitMax !== undefined ? Number(q.limitMax) : 1,
    bendPivot:   Number(q.bendPivot)  || 0,
    subdivs:     Number(q.subdivs)    || 0,
  }
}

app.post('/deform', upload.single('model'), (req, res) => {
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-deformed.glb`)
  const input = req.file ? req.file.path : (req.body.shape || 'SPHERE').toUpperCase()
  runDeform(input, outputPath, deformParamsFromQuery(req.body), res)
})

app.get('/deform/sphere', (req, res) => {
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-deformed.glb`)
  runDeform('SPHERE', outputPath, deformParamsFromQuery(req.query), res)
})

app.get('/deform/cube', (req, res) => {
  const outputPath = path.join(JOBS_DIR, `${Date.now()}-deformed.glb`)
  runDeform('CUBE', outputPath, deformParamsFromQuery(req.query), res)
})

// ── Fluid simulation (async job) ─────────────────────────────────────────────

const fluidJobs = new Map()  // jobId → { status, phase, progress, resultPath, proc, error }

app.post('/fluid', upload.single('container'), (req, res) => {
  const jobId         = Date.now().toString()
  const outputJson    = path.join(JOBS_DIR, `${jobId}-fluid.json`)
  const containerPath = req.file?.path ?? null

  const resolution     = Number(req.body.resolution)     || 24
  const frameEnd       = Number(req.body.frameEnd)       || 60
  const viscosity      = req.body.viscosity              || 'water'
  const containerScale = Number(req.body.containerScale) || 1.0
  const containerY     = Number(req.body.containerY)     || 0.0

  console.log(`\n[fluid:${jobId}] resolution=${resolution} frames=${frameEnd} viscosity=${viscosity} container=${containerPath ?? 'none'} scale=${containerScale} y=${containerY}`)

  const job = { status: 'pending', phase: 'queued', progress: 0, resultPath: outputJson, proc: null, error: null }
  fluidJobs.set(jobId, job)

  const blenderArgs = [
    '--background', '--python', path.join(SCRIPTS, 'fluid.py'),
    '--', outputJson, resolution.toString(), frameEnd.toString(), viscosity,
    containerPath || '',         // args[4]: container GLB path or empty string
    containerScale.toString(),   // args[5]: uniform scale multiplier
    containerY.toString(),       // args[6]: Y position offset (Three.js Y = Blender Z)
  ]

  const proc = spawn(BLENDER, blenderArgs)
  job.proc = proc

  proc.stdout.on('data', d => {
    const text = d.toString()
    process.stdout.write(`  [fluid:${jobId}] ${text}`)
    if (text.includes('FLUID_BAKING'))    { job.status = 'running'; job.phase = 'baking' }
    if (text.includes('FLUID_BAKE_DONE')) { job.phase  = 'exporting'; job.progress = 40 }
    const m = text.match(/FLUID_PROGRESS:(\d+)\/(\d+)/)
    if (m) job.progress = 40 + Math.round(60 * parseInt(m[1]) / parseInt(m[2]))
  })
  proc.stderr.on('data', d => process.stderr.write(`  [fluid:${jobId}] ${d}`))

  proc.on('close', code => {
    if (containerPath) fs.unlink(containerPath, () => {})
    if (code !== 0 || !fs.existsSync(outputJson)) {
      job.status = 'error'
      job.error  = `Blender exited with code ${code}`
    } else {
      job.status = 'done'; job.progress = 100; job.phase = 'done'
    }
  })

  proc.on('error', err => { job.status = 'error'; job.error = err.message })

  res.json({ jobId })
})

app.get('/fluid/status/:id', (req, res) => {
  const job = fluidJobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json({ status: job.status, phase: job.phase, progress: job.progress, error: job.error })
})

app.get('/fluid/result/:id', (req, res) => {
  const job = fluidJobs.get(req.params.id)
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' })
  res.sendFile(job.resultPath, err => {
    if (!err) { fs.unlink(job.resultPath, () => {}); fluidJobs.delete(req.params.id) }
  })
})

app.delete('/fluid/:id', (req, res) => {
  const job = fluidJobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Not found' })
  try { job.proc?.kill() } catch (_) {}
  if (job.resultPath) fs.unlink(job.resultPath, () => {})
  fluidJobs.delete(req.params.id)
  res.json({ ok: true })
})

// ── POST /slice ───────────────────────────────────────────────────────────────
// Body: multipart with optional "model" + optional "cutTexture" image
// Fields: shape, cutPositions (JSON), axis, cutColor
// Returns: GLB with N sliced instances side by side

app.post('/slice', upload.fields([
  { name: 'model', maxCount: 1 },
]), (req, res) => {
  const shape          = (req.body.shape || 'SPHERE').toUpperCase()
  const inputPath      = shape === 'MODEL' ? req.files?.model?.[0]?.path : shape
  const textureName    = req.body.cutTextureName || ''
  const textureTiling  = req.body.cutTextureTiling || '1'
  const texturePath    = textureName ? path.join(TEXTURES_DIR, textureName) : null
  const cutPositions   = req.body.cutPositions || '[0.5]'
  const axis           = (req.body.axis || 'Y').toUpperCase()
  const cutColor       = req.body.cutColor || '#cc2222'
  const outputPath     = path.join(JOBS_DIR, `${Date.now()}-sliced.glb`)

  if (shape === 'MODEL' && !inputPath) {
    return res.status(400).json({ error: 'No model file uploaded' })
  }

  console.log(`\n[slice] shape=${shape} axis=${axis} color=${cutColor} texture=${textureName || 'none'} tiling=${textureTiling}`)

  const blenderArgs = [
    '--background', '--python', path.join(SCRIPTS, 'slice.py'),
    '--', outputPath, cutPositions, axis, cutColor, inputPath,
    ...(texturePath ? [texturePath, textureTiling] : []),
  ]

  const blender = spawn(BLENDER, blenderArgs)
  blender.stdout.on('data', d => process.stdout.write(`  [slice] ${d}`))
  blender.stderr.on('data', d => process.stderr.write(`  [slice] ${d}`))

  let settled = false
  blender.on('close', code => {
    if (settled) return; settled = true
    if (shape === 'MODEL' && inputPath) fs.unlink(inputPath, () => {})
    // texturePath points to a bundled asset — never delete it
    if (code !== 0 || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: `Blender slice failed (exit ${code})` })
    }
    res.download(outputPath, 'sliced.glb', () => fs.unlink(outputPath, () => {}))
  })

  blender.on('error', err => {
    if (settled) return; settled = true
    res.status(500).json({ error: blenderStartError(err) })
  })
})

// ── GET /textures — list bundled texture filenames ───────────────────────────
app.get('/textures', (_, res) => {
  try {
    const files = fs.readdirSync(TEXTURES_DIR).filter(f => /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f))
    res.json(files)
  } catch {
    res.json([])
  }
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, blender: BLENDER }))

// ── JSON error handler (prevents Express sending HTML on multer/route errors) ──
app.use((err, req, res, _next) => {
  console.error('[server error]', err.message)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(3001, () => {
  console.log('Simulation server running on http://localhost:3001')
  console.log(`Blender: ${BLENDER}`)
  // If BLENDER is an explicit path (not a bare "blender" on PATH) and it's
  // missing, warn now rather than failing on the first simulation request.
  if (/[\\/]/.test(BLENDER) && !fs.existsSync(BLENDER)) {
    console.warn(`⚠  Blender not found at that path.`)
    console.warn(`   Set BLENDER_PATH to your Blender executable, e.g.:`)
    console.warn(`   macOS:   BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender npm run server`)
    console.warn(`   Windows: BLENDER_PATH="C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe"`)
  }
})
