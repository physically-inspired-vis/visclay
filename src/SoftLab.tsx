import { useRef, useState, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

// ── Types ─────────────────────────────────────────────────────────────────────

type PinMode = 'flag' | 'curtain' | 'sheet' | 'hammock'

interface SimParams {
  gravity:         number
  windZ:           number
  windX:           number
  windTurb:        number
  damping:         number
  constraintIters: number
}

// ── Presets ───────────────────────────────────────────────────────────────────

const PRESETS: Record<string, { pinMode: PinMode } & SimParams> = {
  Flag:    { pinMode: 'flag',    gravity: 2,   windX: 0.5, windZ: 5,   windTurb: 3,   damping: 0.99,  constraintIters: 8  },
  Curtain: { pinMode: 'curtain', gravity: 3,   windX: 0,   windZ: 2,   windTurb: 2,   damping: 0.99,  constraintIters: 8  },
  Sheet:   { pinMode: 'sheet',   gravity: 2.5, windX: 0.5, windZ: 2.5, windTurb: 2.5, damping: 0.99,  constraintIters: 8  },
  Still:   { pinMode: 'curtain', gravity: 4,   windX: 0,   windZ: 0,   windTurb: 0,   damping: 0.995, constraintIters: 12 },
  Hammock: { pinMode: 'hammock', gravity: 6,   windX: 0,   windZ: 0.5, windTurb: 0.5, damping: 0.995, constraintIters: 12 },
}

// ── Geometry builder ──────────────────────────────────────────────────────────

function buildGeo(N: number, M: number, cW: number, cH: number, pinMode: PinMode) {
  const horiz = pinMode === 'hammock'
  const pos = new Float32Array(N * M * 3)
  const uvs = new Float32Array(N * M * 2)

  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i
      const u = i / (N - 1), v = j / (M - 1)
      if (horiz) {
        pos[k*3]   = (u - 0.5) * cW
        pos[k*3+1] = 0
        pos[k*3+2] = (v - 0.5) * cH
      } else {
        pos[k*3]   = (u - 0.5) * cW
        pos[k*3+1] = (0.5 - v) * cH
        pos[k*3+2] = 0
      }
      uvs[k*2] = u; uvs[k*2+1] = 1 - v
    }
  }

  const idx: number[] = []
  for (let j = 0; j < M - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j*N+i, b = a+1, c = a+N, d = c+1
      idx.push(a, c, b, b, c, d)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// ── Simulation data builder ───────────────────────────────────────────────────

function buildSim(N: number, M: number, cW: number, cH: number, pinMode: PinMode) {
  const horiz  = pinMode === 'hammock'
  const count  = N * M
  const pos    = new Float32Array(count * 3)
  const prev   = new Float32Array(count * 3)
  const pinned = new Uint8Array(count)
  const init   = new Float32Array(count * 3)

  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i
      const u = i / (N - 1), v = j / (M - 1)
      if (horiz) {
        pos[k*3]=(u-.5)*cW; pos[k*3+1]=0;        pos[k*3+2]=(v-.5)*cH
      } else {
        pos[k*3]=(u-.5)*cW; pos[k*3+1]=(.5-v)*cH; pos[k*3+2]=0
      }
      prev[k*3]=pos[k*3]; prev[k*3+1]=pos[k*3+1]; prev[k*3+2]=pos[k*3+2]
    }
  }

  switch (pinMode) {
    case 'flag':
      for (let j = 0; j < M; j++) pinned[j * N] = 1         // left column
      break
    case 'curtain':
      for (let i = 0; i < N; i++) pinned[i] = 1              // top row
      break
    case 'sheet':
      pinned[0] = 1; pinned[N - 1] = 1                       // top two corners
      break
    case 'hammock':
      pinned[0]=1; pinned[N-1]=1
      pinned[(M-1)*N]=1; pinned[(M-1)*N+N-1]=1               // all four corners
      break
  }

  for (let i = 0; i < count; i++) {
    init[i*3]=pos[i*3]; init[i*3+1]=pos[i*3+1]; init[i*3+2]=pos[i*3+2]
  }

  // Springs: structural + shear + bend
  const sW = cW / (N - 1), sH = cH / (M - 1)
  const diag = Math.hypot(sW, sH)
  const springs: { a: number; b: number; r: number }[] = []

  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i
      if (i < N-1) springs.push({ a: k, b: k+1,   r: sW       })
      if (j < M-1) springs.push({ a: k, b: k+N,   r: sH       })
      if (i < N-1 && j < M-1) {
        springs.push({ a: k,   b: k+N+1, r: diag })
        springs.push({ a: k+1, b: k+N,   r: diag })
      }
      if (i < N-2) springs.push({ a: k, b: k+2,   r: sW*2     })
      if (j < M-2) springs.push({ a: k, b: k+N*2, r: sH*2     })
    }
  }

  return { pos, prev, pinned, init, springs, N, M }
}

// ── Cloth component ───────────────────────────────────────────────────────────

function ClothSim({ cols, rows, cW, cH, pinMode, paramsRef, color, wireframe }: {
  cols: number; rows: number; cW: number; cH: number; pinMode: PinMode
  paramsRef: React.MutableRefObject<SimParams>
  color: string; wireframe: boolean
}) {
  const geo     = useMemo(() => buildGeo(cols, rows, cW, cH, pinMode), [])
  const sim     = useMemo(() => buildSim(cols, rows, cW, cH, pinMode), [])
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame(({ clock }, delta) => {
    if (!meshRef.current) return
    const { gravity, windZ, windX, windTurb, damping, constraintIters } = paramsRef.current
    const { pos, prev, pinned, init, springs, N, M } = sim
    const t = clock.getElapsedTime()

    const substeps = 5
    const dt = Math.min(delta, 0.033) / substeps

    for (let step = 0; step < substeps; step++) {
      // Verlet integrate
      for (let i = 0; i < N * M; i++) {
        if (pinned[i]) continue
        const i3 = i * 3
        const px = pos[i3], py = pos[i3+1], pz = pos[i3+2]

        // Implicit velocity with air drag
        let vx = (px - prev[i3])   * damping
        let vy = (py - prev[i3+1]) * damping
        let vz = (pz - prev[i3+2]) * damping

        // Gravity (always -Y)
        vy -= gravity * dt * dt

        // Wind + turbulence
        const tx = Math.sin(px * .8 + t * .9) * Math.cos(pz * .5 + t * .6) * windTurb
        const tz = Math.sin(pz * .7 + t * .7) * Math.cos(py * .4 + t * .5) * windTurb
        vx += (windX + tx) * dt * dt
        vz += (windZ + tz) * dt * dt

        prev[i3]=px; prev[i3+1]=py; prev[i3+2]=pz
        pos[i3]  =px+vx; pos[i3+1]=py+vy; pos[i3+2]=pz+vz

        // Soft floor
        if (pos[i3+1] < -3.5) { pos[i3+1]=-3.5; prev[i3+1]=-3.5 }
      }

      // Solve constraints
      for (let iter = 0; iter < constraintIters; iter++) {
        for (const { a, b, r } of springs) {
          const a3=a*3, b3=b*3
          const dx=pos[b3]-pos[a3], dy=pos[b3+1]-pos[a3+1], dz=pos[b3+2]-pos[a3+2]
          const len = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1e-6
          const f   = (len - r) / len * 0.5
          if (!pinned[a]) { pos[a3]+=dx*f; pos[a3+1]+=dy*f; pos[a3+2]+=dz*f }
          if (!pinned[b]) { pos[b3]-=dx*f; pos[b3+1]-=dy*f; pos[b3+2]-=dz*f }
        }
      }

      // Restore pinned to initial position
      for (let i = 0; i < N * M; i++) {
        if (!pinned[i]) continue
        pos[i*3]=init[i*3]; pos[i*3+1]=init[i*3+1]; pos[i*3+2]=init[i*3+2]
      }
    }

    // Upload to GPU
    const attr = geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < N * M; i++) {
      attr.array[i*3]=pos[i*3]; attr.array[i*3+1]=pos[i*3+1]; attr.array[i*3+2]=pos[i*3+2]
    }
    attr.needsUpdate = true
    geo.computeVertexNormals()
  })

  return (
    <mesh ref={meshRef} geometry={geo} castShadow receiveShadow>
      <meshStandardMaterial
        color={color} side={THREE.DoubleSide}
        roughness={0.8} metalness={0} wireframe={wireframe}
      />
    </mesh>
  )
}

// ── Pin indicators ─────────────────────────────────────────────────────────────

function PinDots({ cols, rows, cW, cH, pinMode }: {
  cols: number; rows: number; cW: number; cH: number; pinMode: PinMode
}) {
  const pts = useMemo(() => {
    const N = cols, M = rows
    const horiz = pinMode === 'hammock'
    const p = (i: number, j: number): [number, number, number] => {
      const u = i / (N-1), v = j / (M-1)
      return horiz
        ? [(u-.5)*cW, 0, (v-.5)*cH]
        : [(u-.5)*cW, (.5-v)*cH, 0]
    }
    switch (pinMode) {
      case 'flag':    return Array.from({ length: M }, (_, j) => p(0, j))
      case 'curtain': return Array.from({ length: N }, (_, i) => p(i, 0))
      case 'sheet':   return [p(0, 0), p(N-1, 0)]
      case 'hammock': return [p(0,0), p(N-1,0), p(0,M-1), p(N-1,M-1)]
    }
  }, [cols, rows, cW, cH, pinMode])

  return (
    <>
      {pts.map((pos, i) => (
        <mesh key={i} position={pos}>
          <sphereGeometry args={[0.06, 8, 8]} />
          <meshStandardMaterial color="#ff4455" emissive="#ff2233" emissiveIntensity={0.6} />
        </mesh>
      ))}
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

function Btn({ active, onClick, children, small }: {
  active?: boolean; onClick: () => void; children: React.ReactNode; small?: boolean
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: small ? '5px 0' : '7px 0', fontSize: small ? 10 : 11,
      borderRadius: 5, cursor: 'pointer',
      background: active ? '#2a2a4a' : '#151520',
      color:      active ? '#9999ff' : '#555',
      border:     active ? '1px solid #5E5CE6' : '1px solid #222',
    }}>{children}</button>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <div style={{ width: 28, height: 16, borderRadius: 8, position: 'relative', background: on ? '#5E5CE6' : '#1e1e2a', border: '1px solid #333', transition: 'background .2s' }}>
        <div style={{ position: 'absolute', top: 2, left: on ? 11 : 2, width: 10, height: 10, borderRadius: '50%', background: on ? '#fff' : '#444', transition: 'left .2s' }} />
      </div>
      <span style={{ fontSize: 11, color: on ? '#9999ff' : '#555' }}>{label}</span>
    </div>
  )
}

// ── Sim sliders config ────────────────────────────────────────────────────────

const SIM_SLIDERS: [string, keyof SimParams, number, number, number][] = [
  ['Gravity',          'gravity',         0,    10,  0.1   ],
  ['Wind forward',     'windZ',          -3,    10,  0.1   ],
  ['Wind sideways',    'windX',          -5,     5,  0.1   ],
  ['Turbulence',       'windTurb',        0,     8,  0.1   ],
  ['Damping',          'damping',         0.95,  1,  0.001 ],
  ['Stiffness',        'constraintIters', 1,    20,  1     ],
]

// ── Main ─────────────────────────────────────────────────────────────────────

export default function SoftLab() {
  const [cols,      setCols]      = useState(22)
  const [rows,      setRows]      = useState(22)
  const [cW,        setCW]        = useState(3)
  const [cH,        setCH]        = useState(3)
  const [pinMode,   setPinMode]   = useState<PinMode>('curtain')
  const [resetKey,  setResetKey]  = useState(0)
  const [color,     setColor]     = useState('#5588cc')
  const [wireframe, setWireframe] = useState(false)
  const [showPins,  setShowPins]  = useState(true)
  const [params,    setParams]    = useState<SimParams>(PRESETS.Curtain)

  const paramsRef = useRef<SimParams>(params)
  useEffect(() => { paramsRef.current = params }, [params])

  const setP = (k: keyof SimParams) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setParams(p => ({ ...p, [k]: Number(e.target.value) }))

  const applyPreset = (name: string) => {
    const p = PRESETS[name]
    setPinMode(p.pinMode)
    setParams({ gravity: p.gravity, windX: p.windX, windZ: p.windZ, windTurb: p.windTurb, damping: p.damping, constraintIters: p.constraintIters })
    setResetKey(k => k + 1)
  }

  const sl: React.CSSProperties = { width: '100%', accentColor: '#5E5CE6' }
  const sec = { borderTop: '1px solid #1a1a2a', paddingTop: 12, display: 'flex', flexDirection: 'column' as const, gap: 8 }
  const sLabel: React.CSSProperties = { fontSize: 10, color: '#444', textTransform: 'uppercase', letterSpacing: 1 }

  const clothKey = `${cols}-${rows}-${cW}-${cH}-${pinMode}-${resetKey}`

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', background: '#0a0a12', color: '#ddd' }}>

      {/* ── Panel ── */}
      <div style={{ width: 268, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, borderRight: '1px solid #1a1a2a', overflowY: 'auto' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Soft Lab</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="/shatter"   style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Shatter</a>
            <a href="/deform"    style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Deform</a>
            <a href="/particles" style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Particles</a>
            <a href="/ripple"    style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Ripple</a>
            <a href="/jelly"     style={{ fontSize: 10, color: '#444', textDecoration: 'none' }}>→ Jelly</a>
          </div>
        </div>

        {/* Presets */}
        <div style={sec}>
          <div style={sLabel}>Presets</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {Object.keys(PRESETS).map(name => (
              <button key={name} onClick={() => applyPreset(name)} style={{
                padding: '5px 10px', fontSize: 10, borderRadius: 5, cursor: 'pointer',
                background: '#151520', color: '#777', border: '1px solid #222',
              }}>{name}</button>
            ))}
          </div>
          <button onClick={() => setResetKey(k => k + 1)} style={{
            padding: '7px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
            background: '#151520', color: '#555', border: '1px solid #222',
          }}>↺ Reset cloth</button>
        </div>

        {/* Cloth */}
        <div style={sec}>
          <div style={sLabel}>Cloth</div>
          <Row label={`Resolution: ${cols}×${rows}`}>
            <input type="range" min={8} max={40} step={1} value={cols}
              onChange={e => { const v = Number(e.target.value); setCols(v); setRows(v) }} style={sl} />
          </Row>
          <Row label={`Width: ${cW.toFixed(1)}`}>
            <input type="range" min={1} max={6} step={0.1} value={cW} onChange={e => setCW(Number(e.target.value))} style={sl} />
          </Row>
          <Row label={`Height: ${cH.toFixed(1)}`}>
            <input type="range" min={1} max={6} step={0.1} value={cH} onChange={e => setCH(Number(e.target.value))} style={sl} />
          </Row>
        </div>

        {/* Pin mode */}
        <div style={sec}>
          <div style={sLabel}>Pin mode</div>
          <div style={{ display: 'flex', gap: 5 }}>
            {(['flag', 'curtain', 'sheet', 'hammock'] as PinMode[]).map(m => (
              <Btn key={m} small active={pinMode === m} onClick={() => { setPinMode(m); setResetKey(k => k+1) }}>
                {m[0].toUpperCase() + m.slice(1)}
              </Btn>
            ))}
          </div>
        </div>

        {/* Simulation */}
        <div style={sec}>
          <div style={sLabel}>Simulation</div>
          {SIM_SLIDERS.map(([label, key, min, max, step]) => (
            <Row key={key} label={`${label}: ${
              key === 'constraintIters'
                ? params[key].toFixed(0)
                : key === 'damping'
                  ? params[key].toFixed(3)
                  : params[key].toFixed(2)
            }`}>
              <input type="range" min={min} max={max} step={step} value={params[key]} onChange={setP(key)} style={sl} />
            </Row>
          ))}
        </div>

        {/* Rendering */}
        <div style={sec}>
          <div style={sLabel}>Rendering</div>
          <Row label="Color">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="color" value={color} onChange={e => setColor(e.target.value)}
                style={{ width: 32, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <span style={{ fontSize: 10, color: '#555' }}>{color}</span>
            </div>
          </Row>
          <Toggle on={wireframe} onClick={() => setWireframe(w => !w)} label="Wireframe" />
          <Toggle on={showPins}  onClick={() => setShowPins(p => !p)}  label="Show pins" />
        </div>

      </div>

      {/* ── Canvas ── */}
      <Canvas
        shadows
        camera={{ position: [0, 0.5, 5.5], fov: 45 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 }}
        style={{ flex: 1, background: '#04040c' }}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 8, 4]} intensity={1.8} castShadow shadow-mapSize={[1024, 1024]} />
        <pointLight position={[-4, 1, -2]} intensity={0.6} color="#4466ff" />
        <pointLight position={[3, -1, 3]}  intensity={0.3} color="#ff8844" />
        <OrbitControls makeDefault target={[0, 0, 0]} />

        <ClothSim
          key={clothKey}
          cols={cols} rows={rows} cW={cW} cH={cH}
          pinMode={pinMode} paramsRef={paramsRef}
          color={color} wireframe={wireframe}
        />

        {showPins && (
          <PinDots key={`pins-${clothKey}`} cols={cols} rows={rows} cW={cW} cH={cH} pinMode={pinMode} />
        )}

        {/* Floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3, 0]} receiveShadow>
          <planeGeometry args={[14, 14]} />
          <meshStandardMaterial color="#09090f" roughness={0.95} />
        </mesh>
      </Canvas>

    </div>
  )
}
