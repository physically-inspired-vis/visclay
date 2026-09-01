import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRID = 90   // NxN particles
const SIZE = 10   // world-space water size

// ── Water simulation ──────────────────────────────────────────────────────────

function WaterSim({ waveSpeed, damping, disturbAmp, modelUrl, resetKey }: {
  waveSpeed:  number
  damping:    number
  disturbAmp: number
  modelUrl:   string | null
  resetKey:   number
}) {
  const hRef  = useRef(new Float32Array(GRID * GRID))
  const vRef  = useRef(new Float32Array(GRID * GRID))
  const modelRef    = useRef<THREE.Group | null>(null)
  const [model, setModel] = useState<THREE.Group | null>(null)

  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(SIZE, SIZE, GRID - 1, GRID - 1)
    g.rotateX(-Math.PI / 2)
    return g
  }, [])

  // Clear on reset
  useEffect(() => { hRef.current.fill(0); vRef.current.fill(0) }, [resetKey])

  // Load GLB
  useEffect(() => {
    if (!modelUrl) { setModel(null); return }
    const loader = new GLTFLoader()
    loader.load(modelUrl, (gltf) => {
      const group = gltf.scene
      // Normalize
      const box  = new THREE.Box3().setFromObject(group)
      const size = box.getSize(new THREE.Vector3())
      group.scale.setScalar(0.9 / Math.max(size.x, size.y, size.z))
      box.setFromObject(group)
      group.position.sub(box.getCenter(new THREE.Vector3()))
      group.position.y = 0.5
      // Splash on drop
      const ci = Math.floor(GRID / 2), cj = Math.floor(GRID / 2), R = 8
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          const ni = ci + di, nj = cj + dj
          if (ni >= 0 && ni < GRID && nj >= 0 && nj < GRID) {
            const d = Math.sqrt(di * di + dj * dj)
            if (d <= R) hRef.current[nj * GRID + ni] -= 0.4 * (1 - d / R)
          }
        }
      }
      setModel(group)
    })
  }, [modelUrl])

  const addRipple = useCallback((wx: number, wz: number, amp: number) => {
    const ci = Math.round((wx / SIZE + 0.5) * (GRID - 1))
    const cj = Math.round((wz / SIZE + 0.5) * (GRID - 1))
    const R = 4
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const ni = ci + di, nj = cj + dj
        if (ni >= 0 && ni < GRID && nj >= 0 && nj < GRID) {
          const d = Math.sqrt(di * di + dj * dj)
          if (d <= R) hRef.current[nj * GRID + ni] -= amp * (1 - d / R)
        }
      }
    }
  }, [])

  useFrame(() => {
    const h  = hRef.current, v = vRef.current
    const c  = Math.min(waveSpeed, 0.49)  // CFL stability limit
    const EDGE = 7

    // Wave step
    for (let j = 1; j < GRID - 1; j++) {
      for (let i = 1; i < GRID - 1; i++) {
        const k   = j * GRID + i
        const lap = h[(j-1)*GRID+i] + h[(j+1)*GRID+i] + h[j*GRID+i-1] + h[j*GRID+i+1] - 4 * h[k]
        v[k] = (v[k] + c * lap) * damping
      }
    }
    for (let k = 0; k < GRID * GRID; k++) h[k] += v[k]

    // Absorbing boundary
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const ed = Math.min(i, j, GRID - 1 - i, GRID - 1 - j)
        if (ed < EDGE) {
          const f = (ed / EDGE) ** 2
          const ab = THREE.MathUtils.lerp(0.75, 1.0, f)
          const k = j * GRID + i
          h[k] *= ab; v[k] *= ab
        }
      }
    }

    // Upload to GPU
    const pos = geo.attributes.position as THREE.BufferAttribute
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        pos.setY(j * GRID + i, h[j * GRID + i])
      }
    }
    pos.needsUpdate = true
    geo.computeVertexNormals()

    // Bob floating model
    const m = modelRef.current
    if (m) {
      const ci = Math.round((m.position.x / SIZE + 0.5) * (GRID - 1))
      const cj = Math.round((m.position.z / SIZE + 0.5) * (GRID - 1))
      if (ci >= 0 && ci < GRID && cj >= 0 && cj < GRID) {
        const wh = h[cj * GRID + ci]
        m.position.y = wh + 0.45
        m.rotation.x = wh * 0.25
        m.rotation.z = wh * 0.15
      }
    }
  })

  return (
    <>
      <mesh
        geometry={geo}
        onPointerDown={e => { e.stopPropagation(); addRipple(e.point.x, e.point.z, disturbAmp) }}
        onPointerMove={e => { if (e.buttons > 0) addRipple(e.point.x, e.point.z, disturbAmp * 0.35) }}
      >
        <meshStandardMaterial color="#0a3060" roughness={0.03} metalness={0.45} envMapIntensity={3} />
      </mesh>

      {model && <primitive ref={modelRef} object={model} />}
    </>
  )
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontSize: 10, color: '#555', letterSpacing: 0.4 }}>{label}</div>
      {children}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function RippleLab() {
  const [waveSpeed,  setWaveSpeed]  = useState(0.32)
  const [damping,    setDamping]    = useState(0.995)
  const [disturbAmp, setDisturbAmp] = useState(0.4)
  const [modelUrl,   setModelUrl]   = useState<string | null>(null)
  const [fileName,   setFileName]   = useState('')
  const [resetKey,   setResetKey]   = useState(0)

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
    if (modelUrl) URL.revokeObjectURL(modelUrl)
    setModelUrl(URL.createObjectURL(file))
    setFileName(file.name)
  }, [modelUrl])

  const sl: React.CSSProperties = { width: '100%', accentColor: '#5E5CE6' }
  const sec = { borderTop: '1px solid #1a1a2a', paddingTop: 12, display: 'flex', flexDirection: 'column' as const, gap: 8 }
  const sLabel: React.CSSProperties = { fontSize: 10, color: '#444', textTransform: 'uppercase', letterSpacing: 1 }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#0a0a12', color: '#ddd' }}>

      <div style={{ width: 268, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, borderRight: '1px solid #1a1a2a', overflowY: 'auto' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Ripple Lab</div>
          <div style={{ fontSize: 11, color: '#444', lineHeight: 1.5 }}>
            Click or drag on the water to create waves.
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <a href="/soft"      style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Cloth</a>
            <a href="/jelly"     style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Jelly</a>
            <a href="/particles" style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Particles</a>
          </div>
        </div>

        <div style={sec}>
          <div style={sLabel}>Object on water</div>
          <div
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onDragOver={e => e.preventDefault()}
            onClick={() => document.getElementById('glb-ripple')!.click()}
            style={{
              border: `2px dashed ${modelUrl ? '#5E5CE6' : '#222'}`,
              borderRadius: 8, padding: '10px 8px', textAlign: 'center',
              cursor: 'pointer', fontSize: 11,
              color: modelUrl ? '#9999ff' : '#444',
            }}
          >
            {fileName || 'Drop a GLB — it will float'}
          </div>
          <input id="glb-ripple" type="file" accept=".glb,.gltf" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          {modelUrl && (
            <button onClick={() => { setModelUrl(null); setFileName('') }} style={{
              padding: '5px', fontSize: 10, borderRadius: 5, cursor: 'pointer',
              background: '#151520', color: '#666', border: '1px solid #222',
            }}>Remove object</button>
          )}
        </div>

        <div style={sec}>
          <div style={sLabel}>Simulation</div>
          <Row label={`Wave speed: ${waveSpeed.toFixed(2)}`}>
            <input type="range" min={0.05} max={0.48} step={0.01} value={waveSpeed}
              onChange={e => setWaveSpeed(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Damping: ${damping.toFixed(3)}`}>
            <input type="range" min={0.96} max={0.999} step={0.001} value={damping}
              onChange={e => setDamping(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Disturbance: ${disturbAmp.toFixed(2)}`}>
            <input type="range" min={0.05} max={1.5} step={0.05} value={disturbAmp}
              onChange={e => setDisturbAmp(Number(e.target.value))} style={sl} />
          </Row>
        </div>

        <div style={sec}>
          <button onClick={() => setResetKey(k => k + 1)} style={{
            padding: '8px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
            background: '#151520', color: '#666', border: '1px solid #222',
          }}>↺ Clear water</button>
        </div>

      </div>

      <Canvas
        camera={{ position: [0, 6, 8], fov: 45 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
        style={{ flex: 1, background: '#04040c' }}
      >
        <ambientLight intensity={0.3} />
        <directionalLight position={[5, 8, 3]} intensity={1.5} />
        <Environment preset="sunset" />
        <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.1} />

        <WaterSim
          waveSpeed={waveSpeed}
          damping={damping}
          disturbAmp={disturbAmp}
          modelUrl={modelUrl}
          resetKey={resetKey}
        />

        {/* Pool floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]}>
          <planeGeometry args={[SIZE, SIZE]} />
          <meshStandardMaterial color="#071830" roughness={0.9} />
        </mesh>
      </Canvas>

    </div>
  )
}
