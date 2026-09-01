import { Suspense, useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Canvas, useFrame, useLoader } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import {
  type SceneSave, type ViewType, type DataRow, type DataField, type LabPresetHandle,
  DEFAULT_DATA, priBtnSt, secBtnSt, Sec, SLabel, RowLabel,
  LabNavTitle, LabPresetRow, LabDataPanel,
  LabAdvancedToggle, LabAdvancedPanel, LabViewSelector, LabViewBar,
  type LabView,
  serverFetch, bundledLabPresets,
} from './LabShared'
import { MODEL_PRESETS } from './models'

const SERVER = import.meta.env.VITE_SERVER ?? 'http://localhost:3001'

type Viscosity = 'water' | 'honey' | 'lava'
type Phase     = 'idle' | 'baking' | 'exporting' | 'ready' | 'error'

interface FluidFrame { p: number[]; i: number[] }
interface FluidData  { frameCount: number; fps: number; viscosity: Viscosity; frames: FluidFrame[] }

const FLUID_PRESETS_KEY = 'phys_tool_fluid_presets'
function loadPresets(): SceneSave[] {
  try { return JSON.parse(localStorage.getItem(FLUID_PRESETS_KEY) ?? '[]') } catch { return [] }
}
function persistPresets(saves: SceneSave[]) {
  localStorage.setItem(FLUID_PRESETS_KEY, JSON.stringify(saves))
}

// ── Material per fluid type ───────────────────────────────────────────────────

const MATERIALS: Record<Viscosity, { color: string; emissive: string; emissiveIntensity: number; opacity: number; roughness: number; shininess: number }> = {
  water: { color: '#1a5fa8', emissive: '#000000', emissiveIntensity: 0,   opacity: 0.72, roughness: 0,   shininess: 120 },
  honey: { color: '#cc7700', emissive: '#442200', emissiveIntensity: 0.1, opacity: 0.88, roughness: 0.2, shininess: 60  },
  lava:  { color: '#cc3300', emissive: '#ff2200', emissiveIntensity: 0.6, opacity: 0.9,  roughness: 0.4, shininess: 20  },
}

// ── Fluid scene (shared by all view types) ────────────────────────────────────

function FluidScene({ geos, fps, playing, speed, viscosity, wireframe }: {
  geos: THREE.BufferGeometry[]; fps: number; playing: boolean
  speed: number; viscosity: Viscosity; wireframe: boolean
}) {
  const meshRef  = useRef<THREE.Mesh>(null)
  const timeRef  = useRef(0)
  const frameRef = useRef(0)
  const mat = MATERIALS[viscosity]

  useEffect(() => { timeRef.current = 0; frameRef.current = 0 }, [geos])

  useFrame((_, delta) => {
    if (!playing || !geos.length || !meshRef.current) return
    timeRef.current += delta * speed * fps
    const f = Math.floor(timeRef.current) % geos.length
    if (f !== frameRef.current) { frameRef.current = f; meshRef.current.geometry = geos[f] }
  })

  const domainGeo = useMemo(() => new THREE.BoxGeometry(4, 4, 4), [])
  if (!geos.length) return null

  return (
    <>
      <mesh ref={meshRef} geometry={geos[0]}>
        <meshPhongMaterial
          color={mat.color} emissive={mat.emissive}
          emissiveIntensity={mat.emissiveIntensity}
          specular="#fff" shininess={mat.shininess}
          transparent opacity={mat.opacity}
          side={THREE.DoubleSide} wireframe={wireframe}
        />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[domainGeo]} />
        <lineBasicMaterial color="#1a1a2a" />
      </lineSegments>
    </>
  )
}

// ── Container preview — renders the imported GLB at the same position/scale ──
// Mirrors the normalization Blender applies (fluid.py): fit to ~2.8 units and seat
// the BOTTOM on the domain floor (y = -1.9) so the opening faces up under the inflow.
const CONTAINER_FIT   = 2.8    // must match fluid.py `cont.scale = (2.8/max_dim…)`
const CONTAINER_FLOOR = -1.9   // must match fluid.py seat `-1.9 + half_h`

function ContainerPreview({ url, scale, yOffset }: { url: string; scale: number; yOffset: number }) {
  const gltf = useLoader(GLTFLoader, url)

  // Clone once per GLB load. Compute base bounding box at unit scale so the
  // reference dimensions don't drift as the user drags sliders.
  const [baseScene, baseCenter, baseMaxDim, baseSize] = useMemo(() => {
    const s = gltf.scene.clone(true)
    s.traverse(node => {
      if ((node as THREE.Mesh).isMesh) {
        ;(node as THREE.Mesh).material = new THREE.MeshStandardMaterial({
          color: '#7080c8', transparent: true, opacity: 0.28,
          side: THREE.DoubleSide, depthWrite: false,
        })
      }
    })
    // Temporarily reset root transform to get geometry-only bounding box
    const savedScale = s.scale.clone()
    const savedPos   = s.position.clone()
    s.scale.set(1, 1, 1)
    s.position.set(0, 0, 0)
    const box    = new THREE.Box3().setFromObject(s)
    const sz     = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    s.scale.copy(savedScale)
    s.position.copy(savedPos)
    return [s, center, Math.max(sz.x, sz.y, sz.z, 0.001), sz] as const
  }, [gltf])

  // Direct mutation every render — R3F reads these from the Three.js object
  // each frame, so slider changes reflect immediately without swapping objects.
  const k     = (CONTAINER_FIT / baseMaxDim) * scale
  const halfH = (baseSize.y / 2) * k
  baseScene.scale.setScalar(k)
  // Seat the bottom (baseCenter.y - baseSize.y/2) at the floor, matching the bake.
  baseScene.position.set(-baseCenter.x * k, CONTAINER_FLOOR + halfH - baseCenter.y * k + yOffset, -baseCenter.z * k)

  return <primitive object={baseScene} />
}

// ── Per-view canvas ───────────────────────────────────────────────────────────

function ViewCanvas({ view, geos, fluidMeta, playing, speed, wireframe, containerUrl, containerScale, containerY }: {
  view: LabView
  geos: THREE.BufferGeometry[]
  fluidMeta: { fps: number; viscosity: Viscosity } | null
  playing: boolean; speed: number; wireframe: boolean
  containerUrl: string | null; containerScale: number; containerY: number
}) {
  // Dynamic plays the (always-smooth) simulation; Compare freezes it.
  const isPlaying   = view === 'compare' ? false : playing
  const hasResult   = geos.length > 0

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        camera={{ position: [0, 2, 8], fov: 45 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
        style={{ background: '#000000' }}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 8, 4]} intensity={1.8} />
        <pointLight position={[-4, 2, -2]} intensity={0.8} color="#4488ff" />
        <Environment preset="city" />
        <OrbitControls makeDefault />
        {hasResult && (
          <FluidScene
            geos={geos} fps={fluidMeta?.fps ?? 24}
            playing={isPlaying} speed={speed}
            viscosity={fluidMeta?.viscosity ?? 'water'}
            wireframe={wireframe}
          />
        )}
        {containerUrl && (
          <Suspense fallback={null}>
            <ContainerPreview url={containerUrl} scale={containerScale} yOffset={containerY} />
          </Suspense>
        )}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]} receiveShadow>
          <planeGeometry args={[16, 16]} />
          <meshStandardMaterial color="#080810" roughness={0.9} />
        </mesh>
        <gridHelper args={[16, 24, '#111120', '#0d0d18']} position={[0, -1.99, 0]} />
      </Canvas>
      {!hasResult && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--lab-border)', fontSize: 13, pointerEvents: 'none' }}>
          Bake a fluid simulation to begin
        </div>
      )}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <RowLabel>{label}</RowLabel>
      <div style={{ height: 6, background: 'var(--lab-divider)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${value}%`,
          background: 'linear-gradient(90deg, var(--lab-accent), #5E5CE6)',
          transition: 'width 0.3s ease', borderRadius: 3,
        }} />
      </div>
      <div style={{ fontSize: 10, color: 'var(--lab-text-2)' }}>{value}%</div>
    </div>
  )
}

// ── FluidLab ──────────────────────────────────────────────────────────────────

export default function FluidLab({ embedded, initialPresetId, presetHandleRef, presetSlot }: {
  embedded?: boolean
  initialPresetId?: string
  presetHandleRef?: { current: LabPresetHandle | null }
  presetSlot?: React.ReactNode
} = {}) {
  const [phase,        setPhase]        = useState<Phase>('idle')
  const [progress,     setProgress]     = useState(0)
  const [phaseLabel,   setPhaseLabel]   = useState('')
  const [errorMsg,     setErrorMsg]     = useState('')
  const [jobId,        setJobId]        = useState<string | null>(null)
  const [geos,         setGeos]         = useState<THREE.BufferGeometry[]>([])
  const [fluidMeta,    setFluidMeta]    = useState<{ fps: number; viscosity: Viscosity } | null>(null)

  // Bake params
  const [viscosity,     setViscosity]     = useState<Viscosity>('water')
  const [resolution,    setResolution]    = useState(24)
  const [frameEnd,      setFrameEnd]      = useState(60)
  const [containerFile,  setContainerFile]  = useState<File | null>(null)
  const [containerUrl,   setContainerUrl]   = useState<string | null>(null)
  const [containerScale, setContainerScale] = useState(1.0)
  const [containerY,     setContainerY]     = useState(0.0)

  // Playback
  const [playing,  setPlaying]  = useState(true)
  const [speed,    setSpeed]    = useState(1.0)
  const [wireframe, setWireframe] = useState(false)

  // Views
  // Dynamic plays the simulation (always smooth — no sequencing); Compare freezes it.
  const [view, setView] = useState<LabView>('dynamic')
  // const [view2, setView2] = useState<ViewType | null>(null)
  const [showAdvanced,    setShowAdvanced]    = useState(false)


  // Data
  const [data, setData] = useState<DataRow[]>(DEFAULT_DATA)
  const [draggingField, setDraggingField] = useState<DataField | null>(null)

  // Presets
  const [presets,     setPresets]     = useState<SceneSave[]>(() => loadPresets())
  const [selPresetId, setSelPresetId] = useState('')
  const [saveName,    setSaveName]    = useState<string | null>(null)

  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const isBaking = phase === 'baking' || phase === 'exporting'

  // Manage blob URL lifecycle for container preview
  const handleContainerFile = useCallback((file: File) => {
    setContainerUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
    setContainerFile(file)
  }, [])
  const handleRemoveContainer = useCallback(() => {
    setContainerUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setContainerFile(null)
    setContainerScale(1.0)
    setContainerY(0.0)
  }, [])

  // Dropdown container picker (same system as the other labs): a bundled model is
  // fetched into a File so it can be uploaded to the bake; last option uploads.
  const [loadingContainer, setLoadingContainer] = useState(false)
  const pickContainer = useCallback(async (url: string, name: string) => {
    setLoadingContainer(true)
    try {
      const blob = await (await fetch(url)).blob()
      handleContainerFile(new File([blob], `${name}.glb`, { type: 'model/gltf-binary' }))
    } catch { /* ignore fetch errors */ }
    setLoadingContainer(false)
  }, [handleContainerFile])
  const handleContainerSelect = useCallback((val: string) => {
    if (val === '__none__')   { handleRemoveContainer(); return }
    if (val === '__upload__') { document.getElementById('fluid-container-input')!.click(); return }
    const m = MODEL_PRESETS.find(x => x.url === val)
    if (m) pickContainer(m.url, m.name)
  }, [handleRemoveContainer, pickContainer])

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const buildGeos = useCallback((data: FluidData) => {
    const built: THREE.BufferGeometry[] = []
    for (const frame of data.frames) {
      if (!frame.p.length) {
        built.push(built.length > 0 ? built[built.length - 1] : new THREE.BufferGeometry())
        continue
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(frame.p), 3))
      geo.setIndex(frame.i)
      geo.computeVertexNormals()
      built.push(geo)
    }
    return built
  }, [])

  useEffect(() => {
    if (!jobId) return
    pollRef.current = setInterval(async () => {
      try {
        const r = await serverFetch(`${SERVER}/fluid/status/${jobId}`)
        const d = await r.json().catch(() => null)
        if (!d) return
        if (d.status === 'running') {
          setProgress(d.progress)
          setPhaseLabel(d.phase === 'baking' ? 'Baking fluid simulation…' : 'Exporting frames…')
          setPhase(d.phase === 'baking' ? 'baking' : 'exporting')
        }
        if (d.status === 'done') {
          stopPoll()
          setProgress(100); setPhaseLabel('Loading result…')
          const res  = await serverFetch(`${SERVER}/fluid/result/${jobId}`)
          const text = await res.text()
          let parsed: FluidData
          try { parsed = JSON.parse(text) }
          catch { throw new Error(`Result JSON is malformed. Blender may have crashed.`) }
          setGeos(buildGeos(parsed))
          setFluidMeta({ fps: parsed.fps, viscosity: parsed.viscosity })
          setPhase('ready'); setJobId(null)
        }
        if (d.status === 'error') {
          stopPoll(); setPhase('error'); setErrorMsg(d.error || 'Unknown error'); setJobId(null)
        }
      } catch {
        stopPoll(); setPhase('error'); setErrorMsg('Lost connection to server'); setJobId(null)
      }
    }, 800)
    return stopPoll
  }, [jobId, stopPoll, buildGeos])

  const handleBake = useCallback(async () => {
    setPhase('baking'); setProgress(0); setPhaseLabel('Connecting to server…')
    setErrorMsg(''); setGeos([])
    try {
      const health = await serverFetch(`${SERVER}/health`).catch(() => null)
      if (!health?.ok) throw new Error('Simulation server is not running. Start it with: node server/server.mjs')
      const form = new FormData()
      form.append('resolution',     resolution.toString())
      form.append('frameEnd',       frameEnd.toString())
      form.append('viscosity',      viscosity)
      form.append('containerScale', containerScale.toString())
      form.append('containerY',     containerY.toString())
      if (containerFile) form.append('container', containerFile)
      setPhaseLabel('Starting Blender…')
      const r    = await serverFetch(`${SERVER}/fluid`, { method: 'POST', body: form })
      const text = await r.text()
      let data: { jobId?: string; error?: string }
      try { data = JSON.parse(text) } catch { throw new Error(`Server error ${r.status}: ${text.slice(0, 120)}`) }
      if (!r.ok || !data.jobId) throw new Error(data.error || `Server error ${r.status}`)
      setJobId(data.jobId)
    } catch (e: unknown) {
      setPhase('error'); setErrorMsg(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [resolution, frameEnd, viscosity, containerFile, containerScale, containerY])

  const handleCancel = useCallback(async () => {
    if (jobId) { stopPoll(); await serverFetch(`${SERVER}/fluid/${jobId}`, { method: 'DELETE' }).catch(() => {}); setJobId(null) }
    setPhase('idle'); setProgress(0)
  }, [jobId, stopPoll])

  const savePreset = useCallback((name: string) => {
    const save: SceneSave = {
      id: Date.now().toString(), name, createdAt: new Date().toISOString(),
      data: { viscosity, resolution, frameEnd, speed },
    }
    const next = [save, ...presets]
    setPresets(next); persistPresets(next); setSelPresetId(save.id); setSaveName(null)
    return save
  }, [viscosity, resolution, frameEnd, speed, presets])

  const loadPreset = useCallback((id: string) => {
    const p = presets.find(x => x.id === id) ?? bundledLabPresets('fluid').find(x => x.id === id); if (!p) return
    const d = p.data as Record<string, unknown>
    if (d.viscosity)     setViscosity(d.viscosity as Viscosity)
    if (d.resolution != null) setResolution(d.resolution as number)
    if (d.frameEnd   != null) setFrameEnd(d.frameEnd as number)
    if (d.speed      != null) setSpeed(d.speed as number)
  }, [presets])

  const deletePreset = useCallback((id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next); persistPresets(next)
    if (selPresetId === id) setSelPresetId('')
  }, [presets, selPresetId])

  // Hub-driven preset load + expose save/delete to the hub's global preset row.
  useEffect(() => {
    if (initialPresetId) loadPreset(initialPresetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPresetId])

  useEffect(() => {
    if (!presetHandleRef) return
    presetHandleRef.current = { save: savePreset as (n: string) => SceneSave, remove: deletePreset }
    return () => { if (presetHandleRef.current?.save === savePreset) presetHandleRef.current = null }
  }, [presetHandleRef, savePreset, deletePreset])

  const sl: React.CSSProperties = { width: '100%', accentColor: 'var(--lab-accent)' }

  function ViscBtn({ v, label }: { v: Viscosity; label: string }) {
    const active = viscosity === v
    return (
      <button onClick={() => setViscosity(v)} disabled={isBaking} style={{
        flex: 1, padding: '7px 0', fontSize: 10, borderRadius: 6, cursor: isBaking ? 'default' : 'pointer',
        background: active ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
        color:      active ? 'var(--lab-accent)' : 'var(--lab-text-2)',
        border:     active ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
        fontWeight: active ? 600 : 400, fontFamily: 'inherit',
        transition: 'background 0.1s, color 0.1s, border-color 0.1s',
      }}>{label}</button>
    )
  }

  return (
    <div style={{ display: 'flex', height: embedded ? '100%' : '100vh', fontFamily: 'system-ui, sans-serif', background: 'var(--lab-fill)', color: 'var(--lab-text)', position: 'relative' }}>



      {/* ── Left panel ── */}
      <div style={{ width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--lab-border)', background: 'var(--lab-surface)', position: 'relative' }}>

        <LabAdvancedToggle open={showAdvanced} onToggle={() => setShowAdvanced(v => !v)} />

        <div style={{ flex: 1, padding: embedded ? '52px 16px 18px' : '18px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>

          {!embedded && <LabNavTitle name="Fluid Lab" href="/fluid" />}

          {/* Embedded in the hub, the global preset dropdown replaces this row. */}
          {!embedded && (
            <LabPresetRow
              presets={presets} selPresetId={selPresetId} saveName={saveName}
              defaultSaveName={`Fluid ${new Date().toLocaleDateString()}`}
              onSelect={loadPreset} onSave={savePreset} onDelete={() => deletePreset(selPresetId)}
              setSaveName={setSaveName} setSelPresetId={setSelPresetId}
            />
          )}

          {/* Fluid type (Effect) — commented out */}
          {false && (
          <Sec>
            <SLabel>Effect</SLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <ViscBtn v="water" label="Water" />
              <ViscBtn v="honey" label="Honey" />
              <ViscBtn v="lava"  label="Lava"  />
            </div>
            <div style={{ fontSize: 10, color: 'var(--lab-text-3)', lineHeight: 1.5 }}>
              {{
                water: 'Thin, fast-flowing liquid',
                honey: 'Viscous, slow-moving fluid',
                lava:  'Glowing molten material',
              }[viscosity]}
            </div>
          </Sec>
          )}

          {/* Simulation params */}
          <Sec>
            <SLabel>Simulation</SLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Frames: {frameEnd}</RowLabel>
              <input type="range" min={30} max={120} step={10} value={frameEnd}
                onChange={e => setFrameEnd(Number(e.target.value))} disabled={isBaking} style={sl} />
            </div>
          </Sec>

          {/* Container import */}
          <Sec>
            <SLabel>Container (optional)</SLabel>
            <select value="" disabled={isBaking} onChange={e => handleContainerSelect(e.target.value)}
              style={{
                width: '100%', background: 'var(--lab-surface)', border: '1px solid var(--lab-border)',
                color: containerFile ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 11,
                padding: '7px 8px', outline: 'none', cursor: isBaking ? 'default' : 'pointer', fontFamily: 'inherit',
              }}>
              <option value="">{loadingContainer ? 'Loading…' : (containerFile?.name || 'Select a container…')}</option>
              {containerFile && <option value="__none__">None</option>}
              {MODEL_PRESETS.map(m => <option key={m.url} value={m.url}>{m.name}</option>)}
              <option value="__upload__">Upload custom GLB…</option>
            </select>
            <input id="fluid-container-input" type="file" accept=".glb,.gltf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleContainerFile(f) }} />
            {containerFile && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                  <RowLabel>Scale: {containerScale.toFixed(2)}×</RowLabel>
                  <input type="range" min={0.2} max={2.0} step={0.05} value={containerScale}
                    onChange={e => setContainerScale(Number(e.target.value))} disabled={isBaking} style={sl} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <RowLabel>Y position: {containerY >= 0 ? '+' : ''}{containerY.toFixed(2)}</RowLabel>
                  <input type="range" min={-1.0} max={1.2} step={0.05} value={containerY}
                    onChange={e => setContainerY(Number(e.target.value))} disabled={isBaking} style={sl} />
                </div>
                <button onClick={handleRemoveContainer} disabled={isBaking} style={secBtnSt(isBaking)}>
                  Remove container
                </button>
              </>
            )}
          </Sec>

          {/* Bake / Progress / Error */}
          {isBaking ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ProgressBar value={progress} label={phaseLabel} />
              <button onClick={handleCancel} style={secBtnSt(false)}>✕ Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {phase === 'error' && (
                <div style={{ fontSize: 10, color: 'var(--lab-danger)', lineHeight: 1.5, padding: '8px 10px', background: '#fff0ef', borderRadius: 5, border: '1px solid #ffd4d0' }}>
                  {errorMsg}
                </div>
              )}
              <button onClick={handleBake} style={priBtnSt(false)}>
                {phase === 'error' ? '↺ Retry bake' : '▶ Bake simulation'}
              </button>
            </div>
          )}

          {/* Playback controls — only after baking */}
          {phase === 'ready' && geos.length > 0 && (
            <Sec>
              <SLabel>Playback</SLabel>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={() => setPlaying(p => !p)} style={{
                  padding: '6px 16px', fontSize: 13, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                  background: playing ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
                  color:      playing ? 'var(--lab-accent)' : 'var(--lab-text-2)',
                  border:     playing ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
                }}>
                  {playing ? '⏸' : '▶'}
                </button>
                <div style={{ fontSize: 10, color: 'var(--lab-text-3)' }}>{geos.length} frames · {fluidMeta?.fps}fps</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <RowLabel>Speed: {speed.toFixed(2)}×</RowLabel>
                <input type="range" min={0.1} max={3} step={0.05} value={speed}
                  onChange={e => setSpeed(Number(e.target.value))} style={sl} />
              </div>
              <button onClick={() => { setPhase('idle'); setGeos([]) }} style={secBtnSt(false)}>
                ← New simulation
              </button>
            </Sec>
          )}

        </div>

        {/* Global preset row (hub) sits just above the data panel when embedded. */}
        {embedded && presetSlot && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--lab-border)', background: 'var(--lab-surface)' }}>
            {presetSlot}
          </div>
        )}

        <LabDataPanel data={data} onDataChange={setData} />
      </div>

      {/* ── Advanced panel ── */}
      <LabAdvancedPanel open={showAdvanced}>
        <Sec>
          <SLabel>Resolution</SLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            {([16, 24, 32] as const).map(r => (
              <button key={r} onClick={() => setResolution(r)} disabled={isBaking} style={{
                flex: 1, padding: '7px 0', fontSize: 10, borderRadius: 6, cursor: isBaking ? 'default' : 'pointer',
                background: resolution === r ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
                color:      resolution === r ? 'var(--lab-accent)' : 'var(--lab-text-2)',
                border:     resolution === r ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
                fontWeight: resolution === r ? 600 : 400, fontFamily: 'inherit',
              }}>{r === 16 ? 'Fast' : r === 24 ? 'Default' : 'Quality'}</button>
            ))}
          </div>
        </Sec>
        <Sec>
          <SLabel>Display</SLabel>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, cursor: 'pointer', color: 'var(--lab-text-2)' }}>
            <input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)}
              style={{ accentColor: 'var(--lab-accent)' }} />
            Wireframe
          </label>
        </Sec>
      </LabAdvancedPanel>

      {/* ── Viewport ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

        <div style={{ flex: 1, position: 'relative' }}>
          <ViewCanvas view={view} geos={geos} fluidMeta={fluidMeta} playing={playing} speed={speed} wireframe={wireframe} containerUrl={containerUrl} containerScale={containerScale} containerY={containerY} />
        </div>

        {/* LEGACY two-view split — commented out
        {view2 !== null && (
          <div style={{ flex: 1, position: 'relative', borderTop: '1px solid var(--lab-divider)' }}>
            <ViewCanvas viewType={view2} geos={geos} fluidMeta={fluidMeta} playing={playing} speed={speed} containerUrl={containerUrl} containerScale={containerScale} containerY={containerY} />
          </div>
        )}
        <LabViewSelector
          view1={view1} view2={view2}
          onView1={v => setView1(v)} onView2={v => setView2(v)}
          onAdd={() => setView2(view1 === 'effect' ? 'static' : 'effect')}
          onRemove={() => setView2(null)}
        />
        */}

        <LabViewBar view={view} onChange={setView} options={{
          speed, onSpeed: setSpeed,
          // Fluids are always smooth, no sequencing → only the speed option.
        }} />
      </div>
    </div>
  )
}
