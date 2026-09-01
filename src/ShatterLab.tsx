import { useRef, useState, useCallback, useMemo, Suspense, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useLoader }        from '@react-three/fiber'
import { OrbitControls, Environment, Html } from '@react-three/drei'
import { GLTFLoader }       from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import {
  type SceneSave, type Shape, type DataRow, type DataField, type LabPresetHandle,
  type ColumnMeta,
  secBtnSt, Sec, SLabel, RowLabel,
  LabNavTitle, LabPresetRow, LabModelSection, LabDataPanel,
  LabAdvancedToggle, LabAdvancedPanel, LabViewBar,
  ReferencePanel, ReferenceButton, referenceForData,
  type LabView,
  DATASET_BANK, DATASET_GENERIC, DATASETS,
  serverFetch, bundledLabPresets,
} from './LabShared'
import { MODEL_PRESETS } from './models'

const SERVER = import.meta.env.VITE_SERVER ?? 'http://localhost:3001'

type FractureMethod = 'bisect' | 'voronoi'
type CutStrategy   = 'random' | 'largest'
type ShatterAnim   = 'exploded' | 'gravity'   // dynamic-view animation style

// ShatterLab-specific data: default piece-count categories for the comparison view
const SHATTER_DATA: DataRow[] = [
  { category: 'Fine',   value: 1,  percentage: 25 },
  { category: 'Low',    value: 5,  percentage: 25 },
  { category: 'Medium', value: 15, percentage: 25 },
  { category: 'High',   value: 50, percentage: 25 },
]

// Bank-failures preset: dataset (with its reference) lives in LabShared.
// Matched as a substring of the preset name (like the whale preset in Deform).
const BANK_DATA    = DATASET_BANK.data
const BANK_COLUMNS = DATASET_BANK.columns
const BANK_PRESET_MATCH = /bank|co2|failure/

// Every data row bakes one object whose piece count IS the row's value.
const pieceCount = (row: DataRow) => Math.max(1, Math.min(200, Math.round(row.value)))
// X positions for n side-by-side compare groups.
const compareX = (i: number, n: number) => (i - (n - 1) / 2) * 3.0

// Unit shown after each value in the cycling label ("140 bank failures"). Derived
// from the current dataset's value-column label; falls back to "pieces".
function valueUnit(data: DataRow[], columns?: ColumnMeta[]): string {
  const ds  = DATASETS.find(d => d.data === data)
  const col = (columns ?? ds?.columns)?.find(c => c.field === 'value')
  return col ? col.label.toLowerCase() : 'pieces'
}

// ── Baked-model persistence (IndexedDB) ───────────────────────────────────────
// GLBs are far too big for localStorage, so a preset's baked fragments live in
// IndexedDB keyed by the preset id. The localStorage preset just carries a
// `hasModels` flag; the geometry is rehydrated into blob URLs on load.

const IDB_NAME = 'phys_tool_labs'
const IDB_STORE = 'shatter_models'
interface BakedRecord { buffers: (ArrayBuffer | null)[]; rows: DataRow[]; unit: string }

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}
async function idbPut(key: string, value: BakedRecord): Promise<void> {
  const db = await idbOpen()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
  db.close()
}
async function idbGet(key: string): Promise<BakedRecord | undefined> {
  const db = await idbOpen()
  const rec = await new Promise<BakedRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result as BakedRecord | undefined)
    req.onerror   = () => reject(req.error)
  })
  db.close()
  return rec
}
async function idbDelete(key: string): Promise<void> {
  const db = await idbOpen()
  await new Promise<void>(resolve => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
  db.close()
}
const GLB_MIME = 'model/gltf-binary'

const SHATTER_PRESETS_KEY = 'phys_tool_shatter_presets'
function loadPresets(): SceneSave[] {
  try { return JSON.parse(localStorage.getItem(SHATTER_PRESETS_KEY) ?? '[]') } catch { return [] }
}
function persistPresets(saves: SceneSave[]) {
  localStorage.setItem(SHATTER_PRESETS_KEY, JSON.stringify(saves))
}

// ── One object's explode-and-return animation (used by the cycling view) ──────
// No Bounds/camera-fit here: bakes are normalized (max-dim 2 at origin), so the
// parent canvas keeps a fixed camera and the objects swap without view jumps.
// Fragment origins are cached in userData so revisiting a url mid-animation
// (the loader caches scenes) never captures exploded positions as "rest".

// Explosion offset per fragment. Each fragment's geometry-bbox centre gives its
// position within the object; the offset from the group centroid, scaled by a
// factor, uniformly EXPANDS the object. Because it's proportional to distance
// (not a fixed push), every object — 3 pieces or 157 — looks equally exploded at
// the same factor. mesh.position starts at 0 (geometry holds the shape), so
// setting position = off × factor is the whole explosion.
interface FragOff { mesh: THREE.Mesh; off: THREE.Vector3 }

function explodeOffsets(root: THREE.Object3D): FragOff[] {
  const meshes: THREE.Mesh[] = []
  root.traverse(n => { if ((n as THREE.Mesh).isMesh) meshes.push(n as THREE.Mesh) })
  const centers = meshes.map(m => {
    m.geometry.computeBoundingBox()
    return m.geometry.boundingBox!.getCenter(new THREE.Vector3())
  })
  const group = new THREE.Vector3()
  centers.forEach(c => group.add(c))
  if (centers.length) group.divideScalar(centers.length)
  return meshes.map((mesh, i) => {
    const off = centers[i].clone().sub(group)
    if (off.length() < 1e-4) off.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.15)
    return { mesh, off }
  })
}

function CycleExploded({ url, speed = 1, amount }: { url: string; speed?: number; amount: number }) {
  const gltf      = useLoader(GLTFLoader, url)
  const fragments = useRef<FragOff[]>([])
  const elapsed   = useRef(0)
  const amtRef    = useRef(amount)
  amtRef.current  = amount

  useEffect(() => {
    fragments.current = explodeOffsets(gltf.scene)
    elapsed.current = 0
    fragments.current.forEach(({ mesh }) => mesh.position.set(0, 0, 0))
  }, [gltf])

  useFrame((_, delta) => {
    elapsed.current += delta * speed
    const t = (Math.sin(elapsed.current * 1.0 - Math.PI / 2) + 1) / 2   // 0 → 1 → 0
    const k = t * amtRef.current
    fragments.current.forEach(({ mesh, off }) => mesh.position.copy(off).multiplyScalar(k))
  })

  return <primitive object={gltf.scene} />
}

// ── Dynamic view: cycle through the baked objects one after another ───────────
// Like the air-pollution preset: each data row's object gets the stage for one
// animation cycle (exploded) or a few seconds (gravity), with its label below.

const CYCLE_EXPLODED = Math.PI * 2   // one explode-and-return at speed 1
const CYCLE_GRAVITY  = 5             // seconds per object in gravity mode

function CyclingShatterView({ urls, rows, anim, impulse, physicsKey, speed, showLabels, unit, explode }: {
  urls: (string | null)[]; rows: DataRow[]; anim: ShatterAnim
  impulse: number; physicsKey: number; speed: number; showLabels: boolean; unit: string; explode: number
}) {
  // Only cycle through slots whose bake succeeded.
  const slots = useMemo(
    () => urls.map((u, i) => ({ url: u, row: rows[i] })).filter((s): s is { url: string; row: DataRow } => !!s.url && !!s.row),
    [urls, rows]
  )
  const [idx, setIdx] = useState(0)
  const elapsed = useRef(0), idxRef = useRef(0)
  const period = anim === 'exploded' ? CYCLE_EXPLODED : CYCLE_GRAVITY

  useEffect(() => { elapsed.current = 0; idxRef.current = 0; setIdx(0) }, [slots, anim])

  useFrame((_, delta) => {
    if (slots.length < 2) return
    elapsed.current += delta * speed
    if (elapsed.current >= period) {
      elapsed.current = 0
      idxRef.current = (idxRef.current + 1) % slots.length
      setIdx(idxRef.current)
    }
  })

  const slot = slots[idx] ?? slots[0]
  if (!slot) return null

  return (
    <>
      {anim === 'exploded' ? (
        <Suspense fallback={null}>
          <CycleExploded key={`${idx}-${slot.url}`} url={slot.url} speed={speed} amount={explode} />
        </Suspense>
      ) : (
        <Physics gravity={[0, -9.81, 0]} timeStep="vary" key={`${physicsKey}-${idx}-${slot.url}`}>
          <Suspense fallback={null}>
            <PhysicsSceneContent url={slot.url} impulse={impulse} />
          </Suspense>
        </Physics>
      )}
      {showLabels && (
        <Html center position={[0, -2.6, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ textAlign: 'center', whiteSpace: 'nowrap', userSelect: 'none', background: 'rgba(0,0,0,0.52)', padding: '4px 14px', borderRadius: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#e0e0f0', letterSpacing: 0.4 }}>{slot.row.category}</div>
            <div style={{ fontSize: 14, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{slot.row.value.toLocaleString()} {unit}</div>
          </div>
        </Html>
      )}
    </>
  )
}

// ── One statically exploded group from a single fracture GLB ─────────────────
// Uniform expansion by `amount` (same factor for every object → same look). The
// scene is cloned once; positions are re-applied whenever the amount changes.

function ExplodedGroup({ url, amount }: { url: string; amount: number }) {
  const gltf = useLoader(GLTFLoader, url)
  const { scene, offs } = useMemo(() => {
    const s = gltf.scene.clone(true)
    return { scene: s, offs: explodeOffsets(s) }
  }, [gltf])
  // Cheap side-effect on render: R3F reads positions each frame.
  offs.forEach(({ mesh, off }) => mesh.position.copy(off).multiplyScalar(amount))
  return <primitive object={scene} />
}

// ── Compare static view — all data rows side by side, each statically exploded ─
// One group per data row (labels appear immediately); geometry fills in when the
// URL for that slot is ready.

function CompareStaticView({ urls, rows, unit, explode }: { urls: (string | null)[]; rows: DataRow[]; unit: string; explode: number }) {
  return (
    <>
      {rows.map((row, i) => (
        <group key={i} position={[compareX(i, rows.length), 0, 0]}>
          {urls[i] && (
            <Suspense fallback={null}>
              <ExplodedGroup url={urls[i]!} amount={explode} />
            </Suspense>
          )}
          <Html center position={[0, -1.8, 0]} style={{ pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', whiteSpace: 'nowrap', userSelect: 'none' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#c0c0e0', letterSpacing: 0.3 }}>
                {row.category}
              </div>
              <div style={{ fontSize: 11, color: '#9a9ab0', marginTop: 2 }}>
                {row.value.toLocaleString()} {unit}
              </div>
            </div>
          </Html>
        </group>
      ))}
    </>
  )
}

// ── Dynamic view (physics simulation) ────────────────────────────────────────

interface FragData {
  geometry:   THREE.BufferGeometry
  material:   THREE.Material | THREE.Material[]
  position:   THREE.Vector3
  quaternion: THREE.Quaternion
}

function PhysicsFragment({ data, center, impulse }: { data: FragData; center: THREE.Vector3; impulse: number }) {
  const rbRef = useRef<RapierRigidBody>(null)
  useEffect(() => {
    if (!rbRef.current) return
    const dir = data.position.clone().sub(center)
    if (dir.length() < 0.001) dir.set(Math.random() - 0.5, 0.5, Math.random() - 0.5)
    dir.normalize().multiplyScalar(impulse)
    rbRef.current.applyImpulse({ x: dir.x, y: dir.y + impulse * 0.3, z: dir.z }, true)
    rbRef.current.applyTorqueImpulse({
      x: (Math.random() - 0.5) * impulse * 0.3,
      y: (Math.random() - 0.5) * impulse * 0.3,
      z: (Math.random() - 0.5) * impulse * 0.3,
    }, true)
  }, [])

  return (
    <RigidBody
      ref={rbRef}
      position={data.position.toArray() as [number, number, number]}
      quaternion={[data.quaternion.x, data.quaternion.y, data.quaternion.z, data.quaternion.w]}
      colliders="hull" restitution={0.3} friction={0.8} linearDamping={0.1} angularDamping={0.15}
    >
      <mesh geometry={data.geometry} material={data.material} />
    </RigidBody>
  )
}

function PhysicsSceneContent({ url, impulse }: { url: string; impulse: number }) {
  const gltf = useLoader(GLTFLoader, url)
  const { fragments, center } = useMemo(() => {
    const frags: FragData[] = []
    gltf.scene.updateWorldMatrix(true, true)
    gltf.scene.traverse(n => {
      if (!(n as THREE.Mesh).isMesh) return
      const mesh = n as THREE.Mesh
      const pos = new THREE.Vector3(); const quat = new THREE.Quaternion()
      mesh.getWorldPosition(pos); mesh.getWorldQuaternion(quat)
      frags.push({ geometry: mesh.geometry, material: mesh.material, position: pos, quaternion: quat })
    })
    const c = new THREE.Vector3()
    frags.forEach(f => c.add(f.position))
    if (frags.length) c.divideScalar(frags.length)
    return { fragments: frags, center: c }
  }, [gltf])

  return (
    <>
      <RigidBody type="fixed" position={[0, -3, 0]}>
        <CuboidCollider args={[15, 0.1, 15]} />
      </RigidBody>
      <mesh position={[0, -3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[30, 30]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
      </mesh>
      {fragments.map((frag, i) => (
        <PhysicsFragment key={i} data={frag} center={center} impulse={impulse} />
      ))}
    </>
  )
}

// ── Per-view canvas ───────────────────────────────────────────────────────────
// Canvas is keyed by runId + view so it remounts once per run (or view switch),
// never mid-run. Compare shows every data row side by side; Dynamic cycles them
// one after another (exploded animation or gravity physics).

function ViewCanvas({ view, anim, compareUrls, rows, compareLoading, impulse, physicsKey, runId, speed = 1, showLabels = true, unit = 'pieces', explode = 0.6 }: {
  view: LabView; anim: ShatterAnim; compareUrls: (string | null)[]; rows: DataRow[]
  compareLoading: boolean; impulse: number; physicsKey: number; runId: number
  speed?: number; showLabels?: boolean; unit?: string; explode?: number
}) {
  const hasAnyCompare = compareUrls.some(u => u !== null)
  const nothingYet    = !hasAnyCompare && !compareLoading

  // Compare gets the wide camera (all rows in frame); Dynamic frames one object.
  const isCompare = view === 'compare'
  const fov = isCompare ? 60 : 45
  const pos = isCompare ? [0, 2, Math.max(10, rows.length * 2.8)] as const : [0, 1.2, 7.5] as const

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        key={`${runId}-${view}`}
        camera={{ fov, position: pos }}
        gl={{ antialias: true }} style={{ background: '#000000' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
        <Environment preset="city" />
        <OrbitControls makeDefault />

        {isCompare ? (
          (hasAnyCompare || compareLoading) && <CompareStaticView urls={compareUrls} rows={rows} unit={unit} explode={explode} />
        ) : hasAnyCompare ? (
          <CyclingShatterView
            urls={compareUrls} rows={rows} anim={anim}
            impulse={impulse} physicsKey={physicsKey} speed={speed} showLabels={showLabels} unit={unit} explode={explode}
          />
        ) : null}
      </Canvas>

      {nothingYet && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--lab-border)', fontSize: 13, pointerEvents: 'none' }}>
          Shatter a shape to begin
        </div>
      )}
    </div>
  )
}

// ── ShatterLab ────────────────────────────────────────────────────────────────

export default function ShatterLab({ embedded, initialPresetId, presetHandleRef, presetSlot }: {
  embedded?: boolean
  initialPresetId?: string
  presetHandleRef?: { current: LabPresetHandle | null }
  presetSlot?: React.ReactNode
} = {}) {
  const [status,    setStatus]    = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message,   setMessage]   = useState('')
  const [fileName,  setFileName]  = useState('')

  const [cutSpread,      setCutSpread]      = useState(0.5)
  const [fractureMethod, setFractureMethod] = useState<FractureMethod>('bisect')
  const [cutStrategy,    setCutStrategy]    = useState<CutStrategy>('random')
  const [voxelDiv,       setVoxelDiv]       = useState(30)
  const [adaptivity,     setAdaptivity]     = useState(0)
  const [impulse,        setImpulse]        = useState(1.5)

  // Dynamic/Compare view + playback options. Dynamic cycles the baked objects one
  // after another (exploded or gravity — chosen in the panel at the right of the
  // viewport); Compare shows all data rows side by side.
  const [view,       setView]       = useState<LabView>('dynamic')
  const [anim,       setAnim]       = useState<ShatterAnim>('exploded')
  const [animSpeed,  setAnimSpeed]  = useState(1.0)
  const [showLabels, setShowLabels] = useState(true)
  const [explode,    setExplode]    = useState(0.6)   // uniform-expansion factor
  const [physicsKey,    setPhysicsKey]    = useState(0)
  const [showAdvanced,  setShowAdvanced]  = useState(false)

  const [data,        setData]        = useState<DataRow[]>(SHATTER_DATA)
  const [dataColumns, setDataColumns] = useState<ColumnMeta[] | undefined>(undefined)
  // Reference is derived from the current dataset (not stored on the preset), so
  // picking a dataset from the panel shows it too. It auto-opens when it changes.
  const reference = useMemo(() => referenceForData(data), [data])
  const [showReference, setShowReference] = useState(false)
  useEffect(() => { setShowReference(!!reference) }, [reference])
  const [draggingField,  setDraggingField]  = useState<DataField | null>(null)
  // One GLB URL per data row (piece count = the row's value), plus the rows
  // snapshotted at bake time so labels always match the baked geometry.
  const [compareUrls,    setCompareUrls]    = useState<(string | null)[]>([])
  const [bakedRows,      setBakedRows]      = useState<DataRow[]>([])
  const [bakedUnit,      setBakedUnit]      = useState('pieces')
  const [compareLoading, setCompareLoading] = useState(false)
  const [runId,          setRunId]          = useState(0)
  const [presets,       setPresets]       = useState<SceneSave[]>(() => loadPresets())
  const [selPresetId,   setSelPresetId]   = useState('')
  const [saveName,      setSaveName]      = useState<string | null>(null)

  const fileRef   = useRef<File | null>(null)
  const isLoading = status === 'loading'

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
    fileRef.current = file
    setFileName(file.name)
    setStatus('idle'); setMessage('')
  }, [])

  // Revoke old compare URLs when replaced (not on mount, only on cleanup)
  const prevCompareUrls = useRef<(string | null)[]>([])
  useEffect(() => {
    const prev = prevCompareUrls.current
    prevCompareUrls.current = compareUrls
    prev.forEach(u => { if (u) URL.revokeObjectURL(u) })
  }, [compareUrls])

  const run = useCallback(async (shape: Shape) => {
    if (shape === 'model' && !fileRef.current) { setMessage('Drop a GLB first'); return }
    const rows = data.map(r => ({ ...r }))   // snapshot: labels stay in sync with bakes
    const unit = valueUnit(data, dataColumns)
    setStatus('loading'); setMessage(`Blender is running… (${rows.length} bakes)`)
    setCompareUrls([])
    setBakedRows(rows)
    setBakedUnit(unit)
    setCompareLoading(true)
    setRunId(id => id + 1)

    const file = fileRef.current

    // One fracture job per data row (piece count = the row's value), fired in
    // parallel; ALL results set at once so the canvas never remounts mid-run.
    Promise.all(
      rows.map(async (row) => {
        const pc = pieceCount(row)
        try {
          const p = { pieces: pc, cutSpread, cutStrategy, fractureMethod, voxelDiv, adaptivity }
          const qs = new URLSearchParams(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))).toString()
          let res: Response
          if (shape === 'sphere')    res = await serverFetch(`${SERVER}/shatter/sphere?${qs}`)
          else if (shape === 'cube') res = await serverFetch(`${SERVER}/shatter/cube?${qs}`)
          else {
            const fd = new FormData()
            fd.append('model', file!)
            Object.entries(p).forEach(([k, v]) => fd.append(k, String(v)))
            res = await serverFetch(`${SERVER}/shatter`, { method: 'POST', body: fd })
          }
          if (res.ok) return URL.createObjectURL(await res.blob())
          console.error(`[bake ${row.category} → ${pc} pieces] server error:`, res.status)
          return null
        } catch (e) {
          console.error(`[bake ${row.category} → ${pc} pieces] failed:`, e)
          return null
        }
      })
    ).then(urls => {
      setCompareUrls(urls)
      const ok = urls.some(u => u !== null)
      setStatus(ok ? 'done' : 'error')
      setMessage(ok
        ? (urls.every(u => u !== null) ? '' : 'Some bakes failed — see console')
        : 'All bakes failed. Is the server running? (node server/server.mjs)')
      if (ok) setPhysicsKey(k => k + 1)
    }).finally(() => setCompareLoading(false))
  }, [data, cutSpread, cutStrategy, fractureMethod, voxelDiv, adaptivity])

  const savePreset = useCallback((name: string) => {
    // If objects are already baked, stash them in IndexedDB so reopening the
    // preset restores the geometry without re-simulating. (The reference is not
    // stored — it's derived from the dataset on load.)
    const urls = compareUrls
    const hasModels = urls.some(u => u !== null)
    const id = Date.now().toString()
    const save: SceneSave = {
      id, name, createdAt: new Date().toISOString(),
      data: { fileName, cutSpread, fractureMethod, cutStrategy, voxelDiv, adaptivity, impulse, anim, dataRows: data, hasModels },
    }
    const next = [save, ...presets]
    setPresets(next); persistPresets(next); setSelPresetId(id); setSaveName(null)
    if (hasModels) {
      const rows = bakedRows, unit = bakedUnit
      ;(async () => {
        const buffers = await Promise.all(urls.map(u => u ? fetch(u).then(r => r.arrayBuffer()) : Promise.resolve(null)))
        await idbPut(id, { buffers, rows, unit })
      })().catch(err => console.error('[shatter] saving baked models failed:', err))
    }
    return save
  }, [fileName, cutSpread, fractureMethod, cutStrategy, voxelDiv, adaptivity, impulse, anim, data, compareUrls, bakedRows, bakedUnit, presets])

  const loadPreset = useCallback((id: string) => {
    const p = presets.find(x => x.id === id) ?? bundledLabPresets('shatter').find(x => x.id === id); if (!p) return
    const d = p.data as Record<string, unknown>
    const isBank    = BANK_PRESET_MATCH.test(p.name.toLowerCase())
    const savedRows = d.dataRows as DataRow[] | undefined
    // Dataset + variable labels: bank preset seeds its dataset; otherwise saved
    // rows. Setting the dataset drives the reference automatically (derived).
    if (isBank)         { setData(BANK_DATA); setDataColumns(BANK_COLUMNS) }
    else if (savedRows) { setData(savedRows); setDataColumns(DATASET_GENERIC.columns) }
    if (d.anim)                  setAnim(d.anim as ShatterAnim)
    if (d.cutSpread     != null) setCutSpread(d.cutSpread as number)
    if (d.fractureMethod)        setFractureMethod(d.fractureMethod as FractureMethod)
    if (d.cutStrategy)           setCutStrategy(d.cutStrategy as CutStrategy)
    if (d.voxelDiv      != null) setVoxelDiv(d.voxelDiv as number)
    if (d.adaptivity    != null) setAdaptivity(d.adaptivity as number)
    if (d.impulse       != null) setImpulse(d.impulse as number)

    // Restore the source model from the bundled models so a re-bake is ready even
    // when the baked fragments aren't in this browser's IndexedDB.
    const savedFile = d.fileName as string | undefined
    if (savedFile) {
      const bundled = MODEL_PRESETS.find(m => m.name === savedFile.replace(/\.(glb|gltf)$/i, ''))
      if (bundled) {
        fetch(bundled.url).then(r => (r.ok ? r.blob() : Promise.reject(new Error('not found'))))
          .then(blob => { fileRef.current = new File([blob], savedFile, { type: GLB_MIME }); setFileName(savedFile) })
          .catch(() => {})
      }
    }

    // Restore baked geometry from IndexedDB if this preset carries it — no re-sim.
    if (d.hasModels) {
      setStatus('loading'); setMessage('Restoring saved objects…')
      setCompareUrls([])
      idbGet(id).then(rec => {
        if (!rec) { setStatus('idle'); setMessage('Saved objects not found — re-bake to regenerate'); return }
        const urls = rec.buffers.map(b => b ? URL.createObjectURL(new Blob([b], { type: GLB_MIME })) : null)
        setBakedRows(rec.rows)
        setBakedUnit(rec.unit)
        setCompareUrls(urls)
        setRunId(r => r + 1)
        setPhysicsKey(k => k + 1)
        setStatus('done'); setMessage('')
      }).catch(err => {
        console.error('[shatter] restoring baked models failed:', err)
        setStatus('idle'); setMessage('Could not restore saved objects')
      })
    } else {
      setStatus('idle'); setMessage('')
      setCompareUrls([])
    }
  }, [presets])

  const deletePreset = useCallback((id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next); persistPresets(next)
    idbDelete(id).catch(() => {})   // drop any stored baked models
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

  function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button onClick={onClick} style={{
        flex: 1, padding: '7px 0', fontSize: 10, borderRadius: 6, cursor: 'pointer',
        background: active ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
        color:      active ? 'var(--lab-accent)' : 'var(--lab-text-2)',
        border:     active ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
        fontWeight: active ? 600 : 400, fontFamily: 'inherit',
        transition: 'background 0.1s, color 0.1s, border-color 0.1s',
      }}>{children}</button>
    )
  }

  return (
    <div style={{ display: 'flex', height: embedded ? '100%' : '100vh', fontFamily: 'system-ui, sans-serif', background: 'var(--lab-fill)', color: 'var(--lab-text)', position: 'relative' }}>



      {/* ── Left panel ── */}
      <div style={{ width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--lab-border)', background: 'var(--lab-surface)', position: 'relative' }}>

        <LabAdvancedToggle open={showAdvanced} onToggle={() => setShowAdvanced(v => !v)} />

        <div style={{ flex: 1, padding: embedded ? '52px 16px 18px' : '18px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>

          {!embedded && <LabNavTitle name="Shatter Lab" href="/shatter" />}

          {/* Embedded in the hub, the global preset dropdown replaces this row. */}
          {!embedded && (
            <LabPresetRow
              presets={presets} selPresetId={selPresetId} saveName={saveName}
              defaultSaveName={`Shatter ${new Date().toLocaleDateString()}`}
              onSelect={loadPreset} onSave={savePreset} onDelete={() => deletePreset(selPresetId)}
              setSaveName={setSaveName} setSelPresetId={setSelPresetId}
            />
          )}

          {/* Main parameters */}
          <Sec>
            <SLabel>Effect</SLabel>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Fracture method</RowLabel>
              <div style={{ display: 'flex', gap: 6 }}>
                <SegBtn active={fractureMethod === 'bisect'}  onClick={() => setFractureMethod('bisect')}>Bisect</SegBtn>
                <SegBtn active={fractureMethod === 'voronoi'} onClick={() => setFractureMethod('voronoi')}>Voronoi</SegBtn>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Size variation: {cutSpread.toFixed(2)}</RowLabel>
              <input type="range" min={0.05} max={1} step={0.05} value={cutSpread}
                onChange={e => setCutSpread(Number(e.target.value))} style={sl} />
            </div>
          </Sec>

          {/* View — Dynamic animation style + explosion amount (used by Compare too) */}
          <Sec>
            <SLabel>View</SLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Dynamic style</RowLabel>
              <div style={{ display: 'flex', gap: 6 }}>
                <SegBtn active={anim === 'exploded'} onClick={() => setAnim('exploded')}>Exploded</SegBtn>
                <SegBtn active={anim === 'gravity'}  onClick={() => setAnim('gravity')}>Gravity</SegBtn>
              </div>
            </div>
            {anim === 'exploded' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <RowLabel>Explosion: {explode.toFixed(2)}×</RowLabel>
                <input type="range" min={0} max={1.5} step={0.05} value={explode}
                  onChange={e => setExplode(Number(e.target.value))} style={sl} />
              </div>
            )}
          </Sec>

          <LabModelSection
            fileName={fileName} onFile={handleFile} onRun={() => run('model')}
            isLoading={isLoading} message={message} status={status} inputId="glb-shatter-input"
            models={MODEL_PRESETS}
          />

        </div>

        {/* Global preset row (hub) sits just above the data panel when embedded. */}
        {embedded && presetSlot && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--lab-border)', background: 'var(--lab-surface)' }}>
            {presetSlot}
          </div>
        )}

        <LabDataPanel data={data} columnsOverride={dataColumns} onDataChange={setData} />
      </div>

      {/* ── Advanced panel (slides in over viewport) ── */}
      <LabAdvancedPanel open={showAdvanced}>
        <Sec>
          <SLabel>Quick Shapes</SLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => run('sphere')} disabled={isLoading} style={secBtnSt(isLoading)}>Sphere</button>
            <button onClick={() => run('cube')}   disabled={isLoading} style={secBtnSt(isLoading)}>Cube</button>
          </div>
        </Sec>

        <Sec>
          <SLabel>Remesh (file only)</SLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <RowLabel>Voxel detail: {voxelDiv}</RowLabel>
            <input type="range" min={10} max={60} step={5} value={voxelDiv}
              onChange={e => setVoxelDiv(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
            <div style={{ fontSize: 9, color: 'var(--lab-text-3)', lineHeight: 1.5 }}>Higher = sharper cuts, slower</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <RowLabel>Adaptivity: {adaptivity.toFixed(2)}</RowLabel>
            <input type="range" min={0} max={1} step={0.05} value={adaptivity}
              onChange={e => setAdaptivity(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
            <div style={{ fontSize: 9, color: 'var(--lab-text-3)', lineHeight: 1.5 }}>Reduces polygons in flat areas</div>
          </div>
        </Sec>

        <Sec>
          <SLabel>Cut Strategy</SLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['random', 'largest'] as const).map(s => (
              <button key={s} onClick={() => setCutStrategy(s)} style={{
                flex: 1, padding: '7px 0', fontSize: 10, borderRadius: 6, cursor: 'pointer',
                background: cutStrategy === s ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
                color:      cutStrategy === s ? 'var(--lab-accent)' : 'var(--lab-text-2)',
                border:     cutStrategy === s ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
                fontWeight: cutStrategy === s ? 600 : 400, fontFamily: 'inherit',
              }}>{s === 'random' ? 'Random' : 'Largest first'}</button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: 'var(--lab-text-3)', lineHeight: 1.5 }}>Largest first → more uniform pieces</div>
        </Sec>

        <Sec>
          <SLabel>Physics (Gravity view)</SLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <RowLabel>Impulse: {impulse.toFixed(1)}</RowLabel>
            <input type="range" min={0} max={5} step={0.1} value={impulse}
              onChange={e => setImpulse(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
          </div>
          {compareUrls.some(u => u !== null) && (
            <button onClick={() => setPhysicsKey(k => k + 1)} style={secBtnSt(false)}>↺ Restart physics</button>
          )}
        </Sec>
      </LabAdvancedPanel>

      {/* ── Viewport ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

        <div style={{ flex: 1, position: 'relative' }}>
          <ViewCanvas
            view={view} anim={anim} compareUrls={compareUrls} rows={bakedRows}
            compareLoading={compareLoading} impulse={impulse} physicsKey={physicsKey} runId={runId}
            speed={animSpeed} showLabels={showLabels} unit={bakedUnit} explode={explode}
          />
        </div>

        {/* ── Preset reference (bottom right) ── */}
        {reference && !showReference && <ReferenceButton onClick={() => setShowReference(true)} />}
        {reference && showReference && (
          <ReferencePanel reference={reference} onClose={() => setShowReference(false)} />
        )}

        <LabViewBar view={view} onChange={setView} options={{
          showLabels, onShowLabels: setShowLabels,
          speed: animSpeed, onSpeed: setAnimSpeed,
          // Exploded/Gravity lives in the viewport panel at the right → no mode here.
        }} />
      </div>
    </div>
  )
}
