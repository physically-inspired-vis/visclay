import { useRef, useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment, Bounds, useBounds } from '@react-three/drei'
import { useLoader } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'

import { serverFetch } from './LabShared'
const SERVER = import.meta.env.VITE_SERVER ?? 'http://localhost:3001'
type ViewMode = 'exploded' | 'physics'
type Shape    = 'model' | 'sphere' | 'cube'

// ── Camera auto-fit ───────────────────────────────────────────────────────────

function FitCamera() {
  const api = useBounds()
  useEffect(() => { api.refresh().fit() }, [api])
  return null
}

// ── Exploded view ─────────────────────────────────────────────────────────────

interface ExplodeFragment { mesh: THREE.Object3D; origPos: THREE.Vector3; direction: THREE.Vector3 }

function ExplodedModel({ url }: { url: string }) {
  const gltf      = useLoader(GLTFLoader, url)
  const fragments = useRef<ExplodeFragment[]>([])
  const elapsed   = useRef(0)

  useEffect(() => {
    const meshes: THREE.Object3D[] = []
    gltf.scene.updateWorldMatrix(true, true)
    gltf.scene.traverse(n => { if ((n as THREE.Mesh).isMesh) meshes.push(n) })
    if (!meshes.length) return

    const center = new THREE.Vector3()
    meshes.forEach(m => { const p = new THREE.Vector3(); m.getWorldPosition(p); center.add(p) })
    center.divideScalar(meshes.length)

    fragments.current = meshes.map(mesh => {
      const origPos = new THREE.Vector3()
      mesh.getWorldPosition(origPos)
      const direction = origPos.clone().sub(center)
      if (direction.length() < 0.001)
        direction.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      direction.normalize()
      return { mesh, origPos: origPos.clone(), direction }
    })
    elapsed.current = 0
  }, [gltf])

  useFrame((_, delta) => {
    elapsed.current += delta
    const t = (Math.sin(elapsed.current * 1.0 - Math.PI / 2) + 1) / 2
    fragments.current.forEach(({ mesh, origPos, direction }) => {
      mesh.position.copy(origPos).addScaledVector(direction, t * 1.5)
    })
  })

  return (
    <Bounds fit clip observe margin={1.4}>
      <FitCamera />
      <primitive object={gltf.scene} />
    </Bounds>
  )
}

// ── Physics view ──────────────────────────────────────────────────────────────

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
    rbRef.current.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * impulse * 0.3, y: (Math.random() - 0.5) * impulse * 0.3, z: (Math.random() - 0.5) * impulse * 0.3 },
      true,
    )
  }, [])

  return (
    <RigidBody
      ref={rbRef}
      position={data.position.toArray() as [number, number, number]}
      quaternion={[data.quaternion.x, data.quaternion.y, data.quaternion.z, data.quaternion.w]}
      colliders="hull"
      restitution={0.3}
      friction={0.8}
      linearDamping={0.1}
      angularDamping={0.15}
    >
      <mesh geometry={data.geometry} material={data.material} />
    </RigidBody>
  )
}

function PhysicsModel({ url, impulse }: { url: string; impulse: number }) {
  const gltf = useLoader(GLTFLoader, url)

  const { fragments, center } = useMemo(() => {
    const frags: FragData[] = []
    gltf.scene.updateWorldMatrix(true, true)
    gltf.scene.traverse(n => {
      if (!(n as THREE.Mesh).isMesh) return
      const mesh = n as THREE.Mesh
      const pos  = new THREE.Vector3()
      const quat = new THREE.Quaternion()
      mesh.getWorldPosition(pos)
      mesh.getWorldQuaternion(quat)
      frags.push({ geometry: mesh.geometry, material: mesh.material, position: pos, quaternion: quat })
    })
    const c = new THREE.Vector3()
    frags.forEach(f => c.add(f.position))
    if (frags.length) c.divideScalar(frags.length)
    return { fragments: frags, center: c }
  }, [gltf])

  return (
    <>
      {/* Floor */}
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

// ── UI helpers ────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: '#888' }}>{label}</div>
      {children}
    </div>
  )
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 600,
      background: active ? '#5E5CE6' : '#1a1a1a',
      color: active ? '#fff' : '#666',
      border: active ? 'none' : '1px solid #333',
      borderRadius: 6, cursor: 'pointer',
    }}>
      {children}
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SimulationLab() {
  const [resultUrl,  setResultUrl]  = useState<string | null>(null)
  const [status,     setStatus]     = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message,    setMessage]    = useState('')
  const [viewMode,   setViewMode]   = useState<ViewMode>('exploded')
  const [physicsKey, setPhysicsKey] = useState(0)
  const [fileName,   setFileName]   = useState('')

  // Controls
  const [pieces,          setPieces]          = useState(8)
  const [cutSpread,       setCutSpread]       = useState(0.5)
  const [cutStrategy,     setCutStrategy]     = useState<'random' | 'largest'>('random')
  const [fractureMethod,  setFractureMethod]  = useState<'bisect' | 'voronoi'>('bisect')
  const [voxelDiv,        setVoxelDiv]        = useState(30)
  const [adaptivity,      setAdaptivity]      = useState(0)
  const [impulse,         setImpulse]         = useState(1.5)

  const fileRef  = useRef<File | null>(null)

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) {
      setMessage('Please upload a .glb or .gltf file'); return
    }
    fileRef.current = file
    setFileName(file.name)
    setResultUrl(null)
    setStatus('idle')
    setMessage('')
  }, [])

  const onDrop       = useCallback((e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }, [handleFile])
  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) handleFile(f) }, [handleFile])

  const run = useCallback(async (shape: Shape) => {
    if (shape === 'model' && !fileRef.current) { setMessage('Drop a GLB first'); return }
    setStatus('loading')
    setMessage('Blender is running…')
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)

    try {
      let res: Response
      const qs = `pieces=${pieces}&cutSpread=${cutSpread}&cutStrategy=${cutStrategy}&adaptivity=${adaptivity}&fractureMethod=${fractureMethod}`
      if (shape === 'sphere') {
        res = await serverFetch(`${SERVER}/shatter/sphere?${qs}`)
      } else if (shape === 'cube') {
        res = await serverFetch(`${SERVER}/shatter/cube?${qs}`)
      } else {
        const form = new FormData()
        form.append('model',       fileRef.current!)
        form.append('pieces',      pieces.toString())
        form.append('cutSpread',   cutSpread.toString())
        form.append('cutStrategy',    cutStrategy)
        form.append('fractureMethod', fractureMethod)
        form.append('voxelDiv',       voxelDiv.toString())
        form.append('adaptivity',  adaptivity.toString())
        res = await serverFetch(`${SERVER}/shatter`, { method: 'POST', body: form })
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? res.statusText)
      }
      const blob = await res.blob()
      setResultUrl(URL.createObjectURL(blob))
      setStatus('done')
      setMessage('')
    } catch (e: unknown) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [pieces, cutSpread, voxelDiv, resultUrl])

  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl) }, [resultUrl])

  const sliderStyle: React.CSSProperties = { width: '100%', accentColor: '#5E5CE6' }
  const isLoading = status === 'loading'

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#0f0f0f', color: '#e0e0e0' }}>

      {/* ── Left panel ── */}
      <div style={{ width: 260, padding: 20, display: 'flex', flexDirection: 'column', gap: 16, borderRight: '1px solid #222', overflowY: 'auto' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Shatter Lab</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <a href="/deform"    style={{ fontSize: 10, color: '#555', textDecoration: 'none' }}>→ Deform</a>
            <a href="/particles" style={{ fontSize: 10, color: '#555', textDecoration: 'none' }}>→ Particles</a>
            <a href="/fluid"     style={{ fontSize: 10, color: '#555', textDecoration: 'none' }}>→ Fluid</a>
          </div>
        </div>

        {/* View mode */}
        <Row label="View Mode">
          <div style={{ display: 'flex', gap: 6 }}>
            <ModeButton active={viewMode === 'exploded'} onClick={() => setViewMode('exploded')}>Exploded</ModeButton>
            <ModeButton active={viewMode === 'physics'}  onClick={() => setViewMode('physics')}>Physics</ModeButton>
          </div>
        </Row>

        {/* Drop zone */}
        <Row label="Model (GLB)">
          <div
            onDrop={onDrop} onDragOver={e => e.preventDefault()}
            onClick={() => document.getElementById('glb-input')!.click()}
            style={{
              border: '2px dashed #333', borderRadius: 8, padding: '14px 10px',
              textAlign: 'center', cursor: 'pointer', fontSize: 12, color: '#555',
            }}
          >
            {fileName || 'Drop GLB or click to browse'}
          </div>
          <input id="glb-input" type="file" accept=".glb,.gltf" style={{ display: 'none' }} onChange={onFileChange} />
        </Row>

        {/* ── Fragment ── */}
        <div style={{ borderTop: '1px solid #1e1e1e', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Fragment</div>

          <Row label="Fracture Method">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['bisect', 'voronoi'] as const).map(m => (
                <button key={m} onClick={() => setFractureMethod(m)} style={{
                  flex: 1, padding: '6px 0', fontSize: 11, borderRadius: 5,
                  background: fractureMethod === m ? '#2a2a4a' : '#1a1a1a',
                  color: fractureMethod === m ? '#9999ff' : '#555',
                  border: fractureMethod === m ? '1px solid #5E5CE6' : '1px solid #2a2a2a',
                  cursor: 'pointer', textTransform: 'capitalize',
                }}>
                  {m}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: '#444', lineHeight: 1.4 }}>
              {fractureMethod === 'voronoi'
                ? 'Natural crack patterns. Slower — best ≤ 50 pieces.'
                : 'Sequential plane cuts. Fast. Good for large counts.'}
            </div>
          </Row>

          <Row label={`Pieces: ${pieces}`}>
            <input type="range" min={2} max={500} step={1} value={pieces}
              onChange={e => setPieces(Number(e.target.value))} style={sliderStyle} />
          </Row>

          <Row label={`Size Variation: ${cutSpread.toFixed(2)}`}>
            <input type="range" min={0.05} max={1} step={0.05} value={cutSpread}
              onChange={e => setCutSpread(Number(e.target.value))} style={sliderStyle} />
            <div style={{ fontSize: 10, color: '#444', lineHeight: 1.4 }}>
              0 = equal-sized pieces (cuts through centre)<br/>
              1 = uneven pieces (cuts placed randomly)
            </div>
          </Row>

          <Row label="Cut Strategy">
            <div style={{ display: 'flex', gap: 6 }}>
              {(['random', 'largest'] as const).map(s => (
                <button key={s} onClick={() => setCutStrategy(s)} style={{
                  flex: 1, padding: '6px 0', fontSize: 11, borderRadius: 5,
                  background: cutStrategy === s ? '#2a2a4a' : '#1a1a1a',
                  color: cutStrategy === s ? '#9999ff' : '#555',
                  border: cutStrategy === s ? '1px solid #5E5CE6' : '1px solid #2a2a2a',
                  cursor: 'pointer',
                }}>
                  {s === 'random' ? 'Random' : 'Largest First'}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: '#444', lineHeight: 1.4 }}>
              Largest First → more uniform sizes
            </div>
          </Row>
        </div>

        {/* ── Remesh (file only) ── */}
        <div style={{ borderTop: '1px solid #1e1e1e', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Remesh — file uploads only</div>

          <Row label={`Voxel Detail: ${voxelDiv}`}>
            <input type="range" min={10} max={60} step={5} value={voxelDiv}
              onChange={e => setVoxelDiv(Number(e.target.value))} style={sliderStyle} />
            <div style={{ fontSize: 10, color: '#444' }}>Higher = sharper cuts, slower</div>
          </Row>

          <Row label={`Adaptivity: ${adaptivity.toFixed(2)}`}>
            <input type="range" min={0} max={1} step={0.05} value={adaptivity}
              onChange={e => setAdaptivity(Number(e.target.value))} style={sliderStyle} />
            <div style={{ fontSize: 10, color: '#444' }}>Reduces polygons in flat areas</div>
          </Row>
        </div>

        {/* ── Physics (only when in physics mode) ── */}
        {viewMode === 'physics' && (
          <div style={{ borderTop: '1px solid #1e1e1e', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1 }}>Physics</div>
            <Row label={`Impulse: ${impulse.toFixed(1)}`}>
              <input type="range" min={0} max={5} step={0.1} value={impulse}
                onChange={e => setImpulse(Number(e.target.value))} style={sliderStyle} />
              <div style={{ fontSize: 10, color: '#444' }}>How hard pieces fly apart on start</div>
            </Row>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => run('model')} disabled={isLoading} style={{
            background: isLoading ? '#222' : '#5E5CE6', color: isLoading ? '#555' : '#fff',
            border: 'none', borderRadius: 8, padding: '11px 0', fontSize: 13, fontWeight: 600,
            cursor: isLoading ? 'wait' : 'pointer',
          }}>
            {isLoading ? 'Running…' : '⚡ Shatter Model'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => run('sphere')} disabled={isLoading} style={{
              flex: 1, background: '#1a1a1a', color: isLoading ? '#444' : '#aaa',
              border: '1px solid #2a2a2a', borderRadius: 8, padding: '9px 0', fontSize: 12,
              cursor: isLoading ? 'wait' : 'pointer',
            }}>🔵 Sphere</button>
            <button onClick={() => run('cube')} disabled={isLoading} style={{
              flex: 1, background: '#1a1a1a', color: isLoading ? '#444' : '#aaa',
              border: '1px solid #2a2a2a', borderRadius: 8, padding: '9px 0', fontSize: 12,
              cursor: isLoading ? 'wait' : 'pointer',
            }}>◻ Cube</button>
          </div>

          {/* Restart button for physics */}
          {viewMode === 'physics' && resultUrl && (
            <button onClick={() => setPhysicsKey(k => k + 1)} style={{
              background: '#1a1a2e', color: '#5E5CE6',
              border: '1px solid #5E5CE6', borderRadius: 8, padding: '9px 0', fontSize: 12,
              cursor: 'pointer',
            }}>↺ Restart Simulation</button>
          )}
        </div>

        {/* Status */}
        {(message || isLoading) && (
          <div style={{
            fontSize: 12, padding: 10, borderRadius: 6, lineHeight: 1.5,
            background: status === 'error' ? '#2a0f0f' : '#111',
            color: status === 'error' ? '#ff6b6b' : '#666',
          }}>
            {isLoading ? 'Blender is running… (10–30 s)' : message}
          </div>
        )}
      </div>

      {/* ── 3D Canvas ── */}
      <div style={{ flex: 1 }}>
        {resultUrl ? (
          <Canvas camera={{ position: [0, 1, 5], fov: 50 }} style={{ background: '#111' }}>
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
            <Environment preset="city" />

            {viewMode === 'exploded' && (
              <Suspense fallback={null}>
                <ExplodedModel url={resultUrl} />
              </Suspense>
            )}

            {viewMode === 'physics' && (
              <Physics gravity={[0, -9.81, 0]} timeStep="vary" key={physicsKey}>
                <Suspense fallback={null}>
                  <PhysicsModel url={resultUrl} impulse={impulse} />
                </Suspense>
              </Physics>
            )}

            <OrbitControls />
          </Canvas>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2a2a2a', fontSize: 13 }}>
            {isLoading
              ? <div style={{ textAlign: 'center', color: '#444' }}><div style={{ fontSize: 28, marginBottom: 10 }}>⏳</div>Blender is fracturing…</div>
              : <div style={{ textAlign: 'center' }}><div style={{ fontSize: 28, marginBottom: 10 }}>💥</div>Choose a shape and hit Shatter</div>
            }
          </div>
        )}
      </div>
    </div>
  )
}
