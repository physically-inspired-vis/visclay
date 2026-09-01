import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import * as THREE from 'three'

// ── Constants ─────────────────────────────────────────────────────────────────

const SUBSTEPS   = 6
const GROUND_Y   = -1.6
const START_Y    =  2.0   // launch height above rest-centroid
const MAX_VERTS  = 2500

// ── Simulation types ──────────────────────────────────────────────────────────

interface Spring { a: number; b: number; rest: number }

interface SimMesh {
  pos:      Float32Array  // current positions  [x,y,z * N]
  prev:     Float32Array  // previous positions
  restPos:  Float32Array  // original rest shape
  springs:  Spring[]
  faces:    Uint32Array   // flat face list [a,b,c * F]
  nVerts:   number
  geo:      THREE.BufferGeometry
}

// ── Mesh builder from THREE.BufferGeometry ────────────────────────────────────

function buildSimMesh(srcGeo: THREE.BufferGeometry): SimMesh | null {
  // Ensure indexed
  let geo = srcGeo.index ? srcGeo.clone() : srcGeo.clone()
  if (!geo.index) {
    const tmp = mergeVertices(geo, 1e-4)
    if (tmp.index) geo = tmp
    else return null
  } else {
    geo = mergeVertices(geo, 1e-4)
  }

  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute
  const idx     = geo.index!

  // Cap vertex count (take first MAX_VERTS, rebuild faces)
  const nVerts = Math.min(posAttr.count, MAX_VERTS)

  // Extract faces (only those with all indices < nVerts)
  const faceList: number[] = []
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i+1), c = idx.getX(i+2)
    if (a < nVerts && b < nVerts && c < nVerts) {
      faceList.push(a, b, c)
    }
  }

  const pos     = new Float32Array(nVerts * 3)
  const prev    = new Float32Array(nVerts * 3)
  const restPos = new Float32Array(nVerts * 3)

  for (let i = 0; i < nVerts; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i)
    pos[i*3]   = x;  pos[i*3+1]   = y + START_Y;  pos[i*3+2]   = z
    prev[i*3]  = x;  prev[i*3+1]  = y + START_Y;  prev[i*3+2]  = z
    restPos[i*3] = x; restPos[i*3+1] = y; restPos[i*3+2] = z
  }

  // Build unique edge springs
  const edgeSet = new Set<string>()
  const springs: Spring[] = []
  for (let f = 0; f < faceList.length; f += 3) {
    const a = faceList[f], b = faceList[f+1], c = faceList[f+2]
    for (const [u, v] of [[a,b],[b,c],[c,a]] as [number,number][]) {
      const key = `${Math.min(u,v)}-${Math.max(u,v)}`
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        const dx = restPos[v*3]-restPos[u*3]
        const dy = restPos[v*3+1]-restPos[u*3+1]
        const dz = restPos[v*3+2]-restPos[u*3+2]
        springs.push({ a: u, b: v, rest: Math.sqrt(dx*dx+dy*dy+dz*dz) })
      }
    }
  }

  // New render geometry with only nVerts vertices
  const renderGeo = new THREE.BufferGeometry()
  const renderPos = new Float32Array(nVerts * 3)
  for (let i = 0; i < nVerts * 3; i++) renderPos[i] = pos[i]
  renderGeo.setAttribute('position', new THREE.BufferAttribute(renderPos, 3))
  renderGeo.setIndex(Array.from(faceList))

  return {
    pos, prev, restPos, springs, nVerts,
    faces: new Uint32Array(faceList),
    geo: renderGeo,
  }
}

// ── Built-in shapes ───────────────────────────────────────────────────────────

function makeSphereGeo() {
  return new THREE.SphereGeometry(0.9, 18, 14)
}
function makeCubeGeo() {
  return new THREE.BoxGeometry(1.6, 1.6, 1.6, 5, 5, 5)
}
function makeTorusGeo() {
  return new THREE.TorusGeometry(0.7, 0.35, 12, 28)
}

// ── Jelly simulation component ────────────────────────────────────────────────

interface JellyProps {
  sim:           SimMesh
  gravity:       number
  stiffness:     number
  shapeK:        number
  damping:       number
  restitution:   number
  color:         string
  wireframe:     boolean
  pokeRef:       React.MutableRefObject<{ pos: THREE.Vector3; strength: number } | null>
  launchRef:     React.MutableRefObject<boolean>
}

function JellySim({ sim, gravity, stiffness, shapeK, damping, restitution, color, wireframe, pokeRef, launchRef }: JellyProps) {

  useFrame((_, rawDelta) => {
    const dt   = Math.min(rawDelta, 0.03) / SUBSTEPS
    const pos  = sim.pos
    const prev = sim.prev
    const rest = sim.restPos
    const N    = sim.nVerts

    // Re-launch
    if (launchRef.current) {
      launchRef.current = false
      for (let i = 0; i < N; i++) {
        pos[i*3]   = rest[i*3];   prev[i*3]   = rest[i*3]
        pos[i*3+1] = rest[i*3+1] + START_Y; prev[i*3+1] = rest[i*3+1] + START_Y
        pos[i*3+2] = rest[i*3+2]; prev[i*3+2] = rest[i*3+2]
      }
    }

    // Poke: apply impulse to nearest vertices
    if (pokeRef.current) {
      const pk = pokeRef.current
      pokeRef.current = null
      const POKE_R = 0.6
      for (let i = 0; i < N; i++) {
        const dx = pos[i*3]-pk.pos.x, dy = pos[i*3+1]-pk.pos.y, dz = pos[i*3+2]-pk.pos.z
        const d  = Math.sqrt(dx*dx+dy*dy+dz*dz)
        if (d < POKE_R) {
          const f = (1 - d / POKE_R) * pk.strength
          const nx = dx/(d||1), ny = dy/(d||1), nz = dz/(d||1)
          prev[i*3]   -= nx * f
          prev[i*3+1] -= ny * f
          prev[i*3+2] -= nz * f
        }
      }
    }

    for (let s = 0; s < SUBSTEPS; s++) {

      // ── Verlet integrate ──────────────────────────────────────────────────
      for (let i = 0; i < N; i++) {
        const i3 = i * 3
        const vx = (pos[i3]   - prev[i3])   * damping
        const vy = (pos[i3+1] - prev[i3+1]) * damping - gravity * dt * dt
        const vz = (pos[i3+2] - prev[i3+2]) * damping

        // Shape-matching spring: pull toward rest centroid offset
        const sx = (rest[i3]   - pos[i3])   * shapeK * dt * dt
        const sy = (rest[i3+1] - pos[i3+1]) * shapeK * dt * dt
        const sz = (rest[i3+2] - pos[i3+2]) * shapeK * dt * dt

        prev[i3]   = pos[i3];   pos[i3]   += vx + sx
        prev[i3+1] = pos[i3+1]; pos[i3+1] += vy + sy
        prev[i3+2] = pos[i3+2]; pos[i3+2] += vz + sz
      }

      // ── Edge spring constraints ───────────────────────────────────────────
      for (const sp of sim.springs) {
        const ai = sp.a * 3, bi = sp.b * 3
        const dx = pos[bi]-pos[ai], dy = pos[bi+1]-pos[ai+1], dz = pos[bi+2]-pos[ai+2]
        const len = Math.sqrt(dx*dx+dy*dy+dz*dz) || 0.0001
        const f   = (len - sp.rest) / len * 0.5 * stiffness
        pos[ai]  += dx*f;  pos[ai+1] += dy*f;  pos[ai+2] += dz*f
        pos[bi]  -= dx*f;  pos[bi+1] -= dy*f;  pos[bi+2] -= dz*f
      }

      // ── Ground collision ──────────────────────────────────────────────────
      for (let i = 0; i < N; i++) {
        if (pos[i*3+1] < GROUND_Y) {
          const vel_y = pos[i*3+1] - prev[i*3+1]
          pos[i*3+1]  = GROUND_Y
          prev[i*3+1] = GROUND_Y - Math.abs(vel_y) * restitution
          // friction on XZ
          prev[i*3]   += (pos[i*3]   - prev[i*3])   * 0.15
          prev[i*3+2] += (pos[i*3+2] - prev[i*3+2]) * 0.15
        }
      }
    }

    // ── Upload to GPU ─────────────────────────────────────────────────────
    const posAttr = sim.geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < N * 3; i++) posAttr.array[i] = pos[i]
    posAttr.needsUpdate = true
    sim.geo.computeVertexNormals()
  })

  return null
}

// ── Scene entry point ─────────────────────────────────────────────────────────

function JellySimScene({ sim, gravity, stiffness, shapeK, damping, restitution, color, wireframe, pokeStrength, launchKey }: {
  sim:          SimMesh
  gravity:      number
  stiffness:    number
  shapeK:       number
  damping:      number
  restitution:  number
  color:        string
  wireframe:    boolean
  pokeStrength: number
  launchKey:    number
}) {
  const pokeRef   = useRef<{ pos: THREE.Vector3; strength: number } | null>(null)
  const launchRef = useRef(false)

  const prevLaunchKey = useRef(launchKey)
  if (launchKey !== prevLaunchKey.current) {
    prevLaunchKey.current = launchKey
    launchRef.current = true
  }

  return (
    <mesh
      geometry={sim.geo}
      onPointerDown={e => {
        e.stopPropagation()
        pokeRef.current = { pos: e.point.clone(), strength: pokeStrength }
      }}
    >
      <meshPhongMaterial
        color={color}
        specular="#ffffff"
        shininess={50}
        transparent
        opacity={0.82}
        side={THREE.DoubleSide}
        wireframe={wireframe}
      />
      <JellySim
        sim={sim}
        gravity={gravity}
        stiffness={stiffness}
        shapeK={shapeK}
        damping={damping}
        restitution={restitution}
        color={color}
        wireframe={wireframe}
        pokeRef={pokeRef}
        launchRef={launchRef}
      />
    </mesh>
  )
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 10, color: '#555', letterSpacing: 0.4 }}>{label}</div>
      {children}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

type Shape = 'sphere' | 'cube' | 'torus' | 'custom'

export default function JellyLab() {
  const [sim,         setSim]         = useState<SimMesh | null>(null)
  const [shape,       setShape]       = useState<Shape>('sphere')
  const [color,       setColor]       = useState('#55aaff')
  const [gravity,     setGravity]     = useState(3.0)
  const [stiffness,   setStiffness]   = useState(0.85)
  const [shapeK,      setShapeK]      = useState(1.2)
  const [damping,     setDamping]     = useState(0.98)
  const [restitution, setRestitution] = useState(0.55)
  const [pokeStrength,setPokeStrength]= useState(0.5)
  const [wireframe,   setWireframe]   = useState(false)
  const [launchKey,   setLaunchKey]   = useState(0)
  const [fileName,    setFileName]    = useState('')
  const [simKey,      setSimKey]      = useState(0)  // forces JellySimScene remount
  const [warnMsg,     setWarnMsg]     = useState('')

  // Build sim from geometry
  const buildFromGeo = useCallback((geo: THREE.BufferGeometry, name = '') => {
    setWarnMsg('')
    const posAttr = mergeVertices(geo, 1e-4).getAttribute('position') as THREE.BufferAttribute
    if (posAttr.count > MAX_VERTS) {
      setWarnMsg(`Mesh has ${posAttr.count} vertices — using first ${MAX_VERTS}.`)
    }
    const result = buildSimMesh(geo)
    if (!result) { setWarnMsg('Could not parse mesh — try a different file.'); return }
    setSim(result)
    setSimKey(k => k + 1)
    if (name) setFileName(name)
  }, [])

  // Build built-in shapes
  useEffect(() => {
    if (shape === 'custom') return
    const geos: Record<Shape, () => THREE.BufferGeometry> = {
      sphere: makeSphereGeo,
      cube:   makeCubeGeo,
      torus:  makeTorusGeo,
      custom: makeSphereGeo,
    }
    buildFromGeo(geos[shape]())
    setFileName('')
  }, [shape, buildFromGeo])

  // Load GLB
  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
    const url = URL.createObjectURL(file)
    const loader = new GLTFLoader()
    loader.load(url, (gltf) => {
      URL.revokeObjectURL(url)
      // Find largest mesh
      let bestMesh: THREE.Mesh | null = null, maxV = 0
      gltf.scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh
          const cnt = m.geometry.getAttribute('position').count
          if (cnt > maxV) { maxV = cnt; bestMesh = m }
        }
      })
      if (!bestMesh) { setWarnMsg('No mesh found in file.'); return }

      const geo = (bestMesh as THREE.Mesh).geometry.clone()
      // Normalize to fit in unit sphere
      const box  = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position') as THREE.BufferAttribute)
      const size = box.getSize(new THREE.Vector3())
      const sc   = 1.8 / Math.max(size.x, size.y, size.z)
      const center = box.getCenter(new THREE.Vector3())
      const posA = geo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < posA.count; i++) {
        posA.setXYZ(i,
          (posA.getX(i) - center.x) * sc,
          (posA.getY(i) - center.y) * sc,
          (posA.getZ(i) - center.z) * sc
        )
      }
      posA.needsUpdate = true

      setShape('custom')
      buildFromGeo(geo, file.name)
    })
  }, [buildFromGeo])

  const sl: React.CSSProperties = { width: '100%', accentColor: '#5E5CE6' }
  const sec = { borderTop: '1px solid #1a1a2a', paddingTop: 12, display: 'flex', flexDirection: 'column' as const, gap: 8 }
  const sLabel: React.CSSProperties = { fontSize: 10, color: '#444', textTransform: 'uppercase', letterSpacing: 1 }
  const shapeBtn = (s: Shape, label: string) => (
    <button onClick={() => setShape(s)} style={{
      flex: 1, padding: '5px 0', fontSize: 10, borderRadius: 5, cursor: 'pointer',
      background: shape === s ? '#5E5CE6' : '#151520',
      color: shape === s ? '#fff' : '#666',
      border: `1px solid ${shape === s ? '#5E5CE6' : '#222'}`,
    }}>{label}</button>
  )

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#0a0a12', color: '#ddd' }}>

      <div style={{ width: 268, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, borderRight: '1px solid #1a1a2a', overflowY: 'auto' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Jelly Lab</div>
          <div style={{ fontSize: 11, color: '#444', lineHeight: 1.5 }}>
            Click the blob to poke it. Simulates soft bodies with spring constraints.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <a href="/soft"   style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Cloth</a>
            <a href="/ripple" style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Ripple</a>
            <a href="/particles" style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Particles</a>
          </div>
        </div>

        <div style={sec}>
          <div style={sLabel}>Shape</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {shapeBtn('sphere', 'Sphere')}
            {shapeBtn('cube',   'Cube')}
            {shapeBtn('torus',  'Torus')}
          </div>
          <div
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onDragOver={e => e.preventDefault()}
            onClick={() => document.getElementById('glb-jelly')!.click()}
            style={{
              border: `2px dashed ${shape === 'custom' ? '#5E5CE6' : '#222'}`,
              borderRadius: 8, padding: '10px 8px', textAlign: 'center',
              cursor: 'pointer', fontSize: 11,
              color: shape === 'custom' ? '#9999ff' : '#444',
            }}
          >
            {shape === 'custom' && fileName ? fileName : 'Drop a GLB — make it jelly'}
          </div>
          <input id="glb-jelly" type="file" accept=".glb,.gltf" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          {warnMsg && <div style={{ fontSize: 9, color: '#ff9955', lineHeight: 1.4 }}>{warnMsg}</div>}
        </div>

        <div style={sec}>
          <div style={sLabel}>Simulation</div>
          <Row label={`Gravity: ${gravity.toFixed(1)}`}>
            <input type="range" min={0} max={12} step={0.5} value={gravity}
              onChange={e => setGravity(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Edge stiffness: ${stiffness.toFixed(2)}`}>
            <input type="range" min={0.1} max={1.0} step={0.05} value={stiffness}
              onChange={e => setStiffness(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Shape spring: ${shapeK.toFixed(2)}`}>
            <input type="range" min={0} max={6} step={0.1} value={shapeK}
              onChange={e => setShapeK(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Damping: ${damping.toFixed(3)}`}>
            <input type="range" min={0.9} max={0.999} step={0.002} value={damping}
              onChange={e => setDamping(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Bounce: ${restitution.toFixed(2)}`}>
            <input type="range" min={0} max={1} step={0.05} value={restitution}
              onChange={e => setRestitution(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Poke strength: ${pokeStrength.toFixed(2)}`}>
            <input type="range" min={0.05} max={2} step={0.05} value={pokeStrength}
              onChange={e => setPokeStrength(Number(e.target.value))} style={sl} />
          </Row>
        </div>

        <div style={sec}>
          <div style={sLabel}>Appearance</div>
          <Row label="Color">
            <input type="color" value={color} onChange={e => setColor(e.target.value)}
              style={{ width: '100%', height: 28, borderRadius: 5, border: '1px solid #222', background: 'none', cursor: 'pointer' }} />
          </Row>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, cursor: 'pointer' }}>
            <input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)} />
            Wireframe
          </label>
        </div>

        <div style={sec}>
          <button onClick={() => setLaunchKey(k => k + 1)} style={{
            padding: '8px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
            background: '#151520', color: '#888', border: '1px solid #222',
          }}>↺ Drop again</button>
        </div>

        {sim && (
          <div style={{ fontSize: 9, color: '#333', lineHeight: 1.5 }}>
            {sim.nVerts} vertices · {sim.springs.length} springs · {sim.faces.length / 3 | 0} faces
          </div>
        )}

      </div>

      <Canvas
        key={simKey}
        camera={{ position: [0, 2, 5], fov: 45 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.3 }}
        style={{ flex: 1, background: '#04040c' }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 6, 3]} intensity={1.5} castShadow />
        <Environment preset="city" />
        <OrbitControls makeDefault />

        {sim && (
          <JellySimScene
            key={simKey}
            sim={sim}
            gravity={gravity}
            stiffness={stiffness}
            shapeK={shapeK}
            damping={damping}
            restitution={restitution}
            color={color}
            wireframe={wireframe}
            pokeStrength={pokeStrength}
            launchKey={launchKey}
          />
        )}

        {/* Ground */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y, 0]} receiveShadow>
          <planeGeometry args={[14, 14]} />
          <meshStandardMaterial color="#101018" roughness={0.9} />
        </mesh>

        {/* Thin grid lines on ground */}
        <gridHelper args={[14, 20, '#1a1a2a', '#111120']} position={[0, GROUND_Y + 0.001, 0]} />
      </Canvas>

    </div>
  )
}
