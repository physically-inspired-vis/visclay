import { useRef, useState, useCallback, useEffect, useMemo, Suspense, Component } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { useLoader } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'
import { useThree } from '@react-three/fiber'
import { EffectComposer }  from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass }      from 'three/examples/jsm/postprocessing/OutputPass.js'
import * as THREE from 'three'
import {
  type SceneSave, type ViewType, type DataRow, type DataField, type LabPresetHandle,
  type ColumnMeta, DATASET_POLLUTION, DATASET_GENERIC, ReferencePanel, ReferenceButton, referenceForData, matchDataset,
  DEFAULT_DATA, Sec, SLabel, RowLabel, secBtnSt,
  LabNavTitle, LabPresetRow, LabDataPanel,
  LabAdvancedToggle, LabAdvancedPanel, LabViewSelector, LabViewBar,
  type LabView, bundledLabPresets,
} from './LabShared'
import { MODEL_PRESETS } from './models'

// ── Types ─────────────────────────────────────────────────────────────────────

type ColorMode = 'speed' | 'heat' | 'rainbow' | 'solid'
type ParticleShape = 'sphere' | 'cube' | 'model'

interface Forces {
  gravity: number; turbulence: number; vortex: number
  attraction: number; damping: number; emitSpeed: number
}

interface RenderOpts {
  colorMode: ColorMode; blending: 'standard' | 'additive'
  brightness: number; solidColor: string
  trailOn: boolean; trailLen: number; trailSize: number
  bloomOn: boolean; bloomInt: number
}

type SimData = { pos: Float32Array; vel: Float32Array; origin: Float32Array; normal: Float32Array }

// ── Presets ───────────────────────────────────────────────────────────────────

const FORCE_PRESETS: Record<string, Forces> = {
  Swarm:    { gravity: 0,    turbulence: 1.5, vortex: 0,   attraction: 3,   damping: 3,   emitSpeed: 0.2 },
  Storm:    { gravity: 0.5,  turbulence: 4,   vortex: 1.5, attraction: 0.3, damping: 0.8, emitSpeed: 0.5 },
  Fountain: { gravity: 2,    turbulence: 0.5, vortex: 0.5, attraction: 0,   damping: 0.5, emitSpeed: 2.0 },
  Orbit:    { gravity: 0,    turbulence: 0.3, vortex: 3,   attraction: 1.5, damping: 1,   emitSpeed: 0.3 },
  Drift:    { gravity: 0.15, turbulence: 0.8, vortex: 0,   attraction: 1,   damping: 2,   emitSpeed: 0.1 },
}
const FORCE_PRESET_KEYS = Object.keys(FORCE_PRESETS)

const DEFAULT_FORCES: Forces = { ...FORCE_PRESETS.Drift }

const DEFAULT_RENDER: RenderOpts = {
  colorMode: 'speed', blending: 'additive',
  brightness: 1.5, solidColor: '#5566ff',
  trailOn: false, trailLen: 50, trailSize: 1.0,
  bloomOn: false, bloomInt: 0.8,
}

const PARTICLE_PRESETS_KEY = 'phys_tool_particle_presets'
function loadPresets(): SceneSave[] {
  try { return JSON.parse(localStorage.getItem(PARTICLE_PRESETS_KEY) ?? '[]') } catch { return [] }
}
function persistPresets(saves: SceneSave[]) {
  localStorage.setItem(PARTICLE_PRESETS_KEY, JSON.stringify(saves))
}

// ── Color utility ─────────────────────────────────────────────────────────────

const _hsl = new THREE.Color()

function getColor(
  vx: number, vy: number, vz: number, py: number,
  mode: ColorMode, brightness: number, solidHex: string,
): [number, number, number] {
  const spd = Math.sqrt(vx * vx + vy * vy + vz * vz)
  const t = Math.min(spd * 0.4, 1)
  let r: number, g: number, b: number

  if (mode === 'speed') {
    r = 0.3 + t * 0.65; g = 0.45 + t * 0.5; b = 1
  } else if (mode === 'heat') {
    if (t < 0.33)      { r = t * 3;         g = 0;              b = 0 }
    else if (t < 0.67) { r = 1;             g = (t - 0.33) * 3; b = 0 }
    else               { r = 1;             g = 1;              b = (t - 0.67) * 3 }
  } else if (mode === 'rainbow') {
    _hsl.setHSL(((py + 2) / 4 + 1) % 1, 1, 0.6)
    r = _hsl.r; g = _hsl.g; b = _hsl.b
  } else {
    _hsl.set(solidHex); r = _hsl.r; g = _hsl.g; b = _hsl.b
  }

  return [r * brightness, g * brightness, b * brightness]
}

const _dummy  = new THREE.Object3D()
const _icolor = new THREE.Color()

// ── Trail shaders ─────────────────────────────────────────────────────────────

const TRAIL_VERT = /* glsl */`
  uniform float uSize;
  attribute float aAlpha;
  attribute vec3  aColor;
  varying   float vAlpha;
  varying   vec3  vColor;
  void main() {
    vAlpha = aAlpha; vColor = aColor;
    vec4 mvPos  = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_PointSize = max(0.5, uSize * aAlpha * (80.0 / -mvPos.z));
  }
`
const TRAIL_FRAG = /* glsl */`
  varying float vAlpha;
  varying vec3  vColor;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float dist = length(uv);
    if (dist > 0.5) discard;
    gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.1, dist));
  }
`

// ── Trail renderer ────────────────────────────────────────────────────────────

function TrailRenderer({ simRef, count, trailLen, renderOptsRef }: {
  simRef: React.MutableRefObject<SimData | null>
  count: number; trailLen: number
  renderOptsRef: React.MutableRefObject<RenderOpts>
}) {
  const totalPts = count * trailLen
  const geoRef   = useRef<THREE.BufferGeometry | null>(null)
  const bufHead  = useRef(new Int32Array(count))
  const bufTrail = useRef(new Float32Array(totalPts * 3))

  const [geo, mat] = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(totalPts * 3).fill(-1e4), 3))
    g.setAttribute('aAlpha',   new THREE.BufferAttribute(new Float32Array(totalPts), 1))
    g.setAttribute('aColor',   new THREE.BufferAttribute(new Float32Array(totalPts * 3), 3))
    const m = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 0.8 } },
      vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })
    geoRef.current = g
    return [g, m]
  }, [totalPts])

  useFrame(() => {
    const sim = simRef.current; const geo = geoRef.current
    if (!sim || !geo) return
    const { colorMode, brightness, solidColor, trailSize } = renderOptsRef.current
    ;(mat as THREE.ShaderMaterial).uniforms.uSize.value = trailSize * 0.8
    const heads = bufHead.current; const trail = bufTrail.current
    const posAttr = geo.attributes.position as THREE.BufferAttribute
    const alpAttr = geo.attributes.aAlpha   as THREE.BufferAttribute
    const colAttr = geo.attributes.aColor   as THREE.BufferAttribute

    for (let i = 0; i < count; i++) {
      const h = (heads[i] + 1) % trailLen
      heads[i] = h
      const tb = (i * trailLen + h) * 3
      trail[tb] = sim.pos[i*3]; trail[tb+1] = sim.pos[i*3+1]; trail[tb+2] = sim.pos[i*3+2]
      const vx = sim.vel[i*3], vy = sim.vel[i*3+1], vz = sim.vel[i*3+2]
      for (let t = 0; t < trailLen; t++) {
        const age = (trailLen - 1 - t) / (trailLen - 1)
        const src = (i * trailLen + ((h - t + trailLen) % trailLen)) * 3
        const dst = (i * trailLen + t) * 3
        posAttr.array[dst] = trail[src]; posAttr.array[dst+1] = trail[src+1]; posAttr.array[dst+2] = trail[src+2]
        alpAttr.array[i * trailLen + t] = age * age
        const py = trail[src + 1]
        const [cr, cg, cb] = getColor(vx*age, vy*age, vz*age, py, colorMode, brightness*0.7, solidColor)
        colAttr.array[dst] = cr; colAttr.array[dst+1] = cg; colAttr.array[dst+2] = cb
      }
    }
    posAttr.needsUpdate = true; alpAttr.needsUpdate = true; colAttr.needsUpdate = true
  })

  return <points geometry={geo} material={mat} />
}

// ── Particle simulation ───────────────────────────────────────────────────────

function ParticleSystem({ simRef, sourceMesh, count, size, forcesRef, renderOptsRef, paused, instanceGeo, instanceMat, instanceSize, speedRef }: {
  simRef: React.MutableRefObject<SimData | null>
  sourceMesh: THREE.Mesh; count: number; size: number
  forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>
  paused?: boolean
  instanceGeo?: THREE.BufferGeometry | null
  instanceMat?: THREE.Material | null
  instanceSize?: number
  speedRef?: React.MutableRefObject<number>
}) {
  const meshRef    = useRef<THREE.InstancedMesh>(null)
  const matRef     = useRef<THREE.MeshStandardMaterial | null>(null)
  const rotRef     = useRef<Float32Array | null>(null)
  const defaultGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0), [])
  const effectiveGeo  = instanceGeo ?? defaultGeo
  const effectiveSize = (instanceGeo && instanceSize != null) ? instanceSize : size

  useEffect(() => {
    const pos = new Float32Array(count * 3); const vel = new Float32Array(count * 3)
    const origin = new Float32Array(count * 3); const normal = new Float32Array(count * 3)
    sourceMesh.updateWorldMatrix(true, false)
    const sampler = new MeshSurfaceSampler(sourceMesh).build()
    const p3 = new THREE.Vector3(); const n3 = new THREE.Vector3()
    const nmat = new THREE.Matrix3().getNormalMatrix(sourceMesh.matrixWorld)
    const es = forcesRef.current.emitSpeed
    for (let i = 0; i < count; i++) {
      sampler.sample(p3, n3)
      p3.applyMatrix4(sourceMesh.matrixWorld); n3.applyMatrix3(nmat).normalize()
      const i3 = i * 3
      origin[i3]=p3.x; origin[i3+1]=p3.y; origin[i3+2]=p3.z
      normal[i3]=n3.x; normal[i3+1]=n3.y; normal[i3+2]=n3.z
      pos[i3]=p3.x; pos[i3+1]=p3.y; pos[i3+2]=p3.z
      const j = 0.08
      vel[i3]=n3.x*es+(Math.random()-.5)*j; vel[i3+1]=n3.y*es+(Math.random()-.5)*j; vel[i3+2]=n3.z*es+(Math.random()-.5)*j
      const age = Math.random() * 2
      pos[i3]+=vel[i3]*age; pos[i3+1]+=vel[i3+1]*age; pos[i3+2]+=vel[i3+2]*age
    }
    simRef.current = { pos, vel, origin, normal }

    // Generate one random quaternion per particle (used when custom instanceGeo is active)
    const rots = new Float32Array(count * 4)
    const _q = new THREE.Quaternion()
    for (let i = 0; i < count; i++) {
      _q.set(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize()
      rots[i*4]=_q.x; rots[i*4+1]=_q.y; rots[i*4+2]=_q.z; rots[i*4+3]=_q.w
    }
    rotRef.current = rots

    // When paused, useFrame never runs so instanceMatrix stays all-zero (invisible).
    // Write instance transforms + blending once here so the static snapshot is visible.
    if (paused) {
      const mesh = meshRef.current
      if (mesh) {
        const { colorMode, brightness, solidColor, blending } = renderOptsRef.current
        const mat = matRef.current
        if (mat && !instanceMat) {
          const wantAdd = blending === 'additive'
          mat.blending   = wantAdd ? THREE.AdditiveBlending : THREE.NormalBlending
          mat.depthWrite  = !wantAdd
          mat.needsUpdate = true
        }
        const rots = rotRef.current
        for (let i = 0; i < count; i++) {
          const i3 = i * 3
          _dummy.position.set(pos[i3], pos[i3+1], pos[i3+2])
          _dummy.scale.setScalar(effectiveSize)
          if (instanceGeo && rots) {
            const i4 = i * 4
            _dummy.quaternion.set(rots[i4], rots[i4+1], rots[i4+2], rots[i4+3])
          } else {
            _dummy.quaternion.set(0, 0, 0, 1)
          }
          _dummy.updateMatrix(); mesh.setMatrixAt(i, _dummy.matrix)
          if (!instanceMat) {
            const [cr, cg, cb] = getColor(vel[i3], vel[i3+1], vel[i3+2], pos[i3+1], colorMode, brightness, solidColor)
            _icolor.setRGB(cr, cg, cb); mesh.setColorAt(i, _icolor)
          }
        }
        mesh.instanceMatrix.needsUpdate = true
        if (!instanceMat && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      }
    }
  }, [sourceMesh, count]) // eslint-disable-line

  useFrame(({ clock }, delta) => {
    const mesh = meshRef.current; const sim = simRef.current
    if (!mesh || !sim) return
    if (paused) return

    const dt = Math.min(delta, 0.05) * (speedRef?.current ?? 1); const t = clock.getElapsedTime()
    const { pos, vel, origin, normal } = sim
    const { gravity, turbulence, vortex, attraction, damping, emitSpeed } = forcesRef.current
    const { colorMode, blending, brightness, solidColor } = renderOptsRef.current

    if (matRef.current) {
      const wantAdd = blending === 'additive'
      const curAdd  = matRef.current.blending === THREE.AdditiveBlending
      if (wantAdd !== curAdd) {
        matRef.current.blending   = wantAdd ? THREE.AdditiveBlending : THREE.NormalBlending
        matRef.current.depthWrite = !wantAdd
        matRef.current.needsUpdate = true
      }
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      let px=pos[i3], py=pos[i3+1], pz=pos[i3+2]
      let vx=vel[i3], vy=vel[i3+1], vz=vel[i3+2]
      const ox=origin[i3], oy=origin[i3+1], oz=origin[i3+2]
      const nx=normal[i3], ny=normal[i3+1], nz=normal[i3+2]

      vy -= gravity * dt * 3
      if (turbulence > 0.01) {
        const sc = 1.2
        vx += (Math.sin(px*sc + t*.71) * Math.cos(pz*sc*.83 + t*.44)) * turbulence * dt * 4
        vy += (Math.sin(py*sc + t*.53) * Math.cos(px*sc*.91 + t*.37)) * turbulence * dt * 4
        vz += (Math.sin(pz*sc + t*.67) * Math.cos(py*sc*.79 + t*.58)) * turbulence * dt * 4
      }
      if (Math.abs(vortex) > 0.001) { vx -= pz * vortex * dt * 2; vz += px * vortex * dt * 2 }
      if (attraction > 0.001) {
        const k = attraction * dt * 8
        vx += (ox-px)*k; vy += (oy-py)*k; vz += (oz-pz)*k
      }
      const dmp = 1 - Math.min(damping * dt * 0.4, 0.95)
      vx*=dmp; vy*=dmp; vz*=dmp
      px+=vx*dt; py+=vy*dt; pz+=vz*dt
      const dx=px-ox, dy=py-oy, dz=pz-oz
      if (py < -10 || dx*dx+dy*dy+dz*dz > 144) {
        px=ox; py=oy; pz=oz
        const j=.08
        vx=nx*emitSpeed+(Math.random()-.5)*j; vy=ny*emitSpeed+(Math.random()-.5)*j; vz=nz*emitSpeed+(Math.random()-.5)*j
      }
      pos[i3]=px; pos[i3+1]=py; pos[i3+2]=pz
      vel[i3]=vx; vel[i3+1]=vy; vel[i3+2]=vz

      _dummy.position.set(px, py, pz)
      _dummy.scale.setScalar(effectiveSize)
      const rots = rotRef.current
      if (instanceGeo && rots) {
        const i4 = i * 4
        _dummy.quaternion.set(rots[i4], rots[i4+1], rots[i4+2], rots[i4+3])
      } else {
        _dummy.quaternion.set(0, 0, 0, 1)
      }
      _dummy.updateMatrix(); mesh.setMatrixAt(i, _dummy.matrix)
      if (!instanceMat) {
        const [cr, cg, cb] = getColor(vx, vy, vz, py, colorMode, brightness, solidColor)
        _icolor.setRGB(cr, cg, cb); mesh.setColorAt(i, _icolor)
      }
    }

    mesh.instanceMatrix.needsUpdate = true
    if (!instanceMat && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <primitive object={effectiveGeo} attach="geometry" />
      {instanceMat
        ? <primitive object={instanceMat} attach="material" />
        : <meshStandardMaterial ref={matRef} roughness={0.05} metalness={0.4} toneMapped={false} transparent />
      }
    </instancedMesh>
  )
}

// ── Shape wrappers ────────────────────────────────────────────────────────────

function BuiltinParticles({ shape, simRef, count, size, forcesRef, renderOptsRef, paused, xOffset = 0, instanceGeo, instanceMat, instanceSize, speedRef }: {
  shape: 'sphere' | 'cube'; simRef: React.MutableRefObject<SimData | null>
  count: number; size: number; forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>; paused?: boolean; xOffset?: number
  instanceGeo?: THREE.BufferGeometry | null
  instanceMat?: THREE.Material | null
  instanceSize?: number
  speedRef?: React.MutableRefObject<number>
}) {
  const mesh = useMemo(() => {
    const geo = shape === 'sphere' ? new THREE.SphereGeometry(1, 32, 16) : new THREE.BoxGeometry(2, 2, 2, 8, 8, 8)
    const m = new THREE.Mesh(geo)
    m.position.set(xOffset, 0, 0)
    m.updateMatrixWorld(true)
    return m
  }, [shape, xOffset])

  return <ParticleSystem key={shape+count+xOffset} simRef={simRef} sourceMesh={mesh} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} paused={paused} instanceGeo={instanceGeo} instanceMat={instanceMat} instanceSize={instanceSize} speedRef={speedRef} />
}

function ModelParticles({ url, simRef, count, size, forcesRef, renderOptsRef, paused, xOffset = 0, speedRef }: {
  url: string; simRef: React.MutableRefObject<SimData | null>
  count: number; size: number; forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>; paused?: boolean; xOffset?: number
  speedRef?: React.MutableRefObject<number>
}) {
  const gltf = useLoader(GLTFLoader, url)
  const mesh = useMemo<THREE.Mesh | null>(() => {
    let best: THREE.Mesh | null = null; let maxV = 0
    gltf.scene.traverse(n => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.geometry.attributes.position.count > maxV) { maxV = m.geometry.attributes.position.count; best = m }
    })
    if (!best) return null
    const bestMesh = best as THREE.Mesh
    // Standalone mesh: bake the model's world transform + apply xOffset
    const standalone = new THREE.Mesh(bestMesh.geometry)
    bestMesh.matrixWorld.decompose(standalone.position, standalone.quaternion, standalone.scale)
    standalone.position.x += xOffset
    standalone.updateMatrix()
    standalone.updateMatrixWorld(true)
    return standalone
  }, [gltf, xOffset])

  if (!mesh) return null
  return <ParticleSystem key={mesh.uuid+count+xOffset} simRef={simRef} sourceMesh={mesh} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} paused={paused} speedRef={speedRef} />
}

// ── Multi-instance comparison: 4 side-by-side with fixed counts ──────────────
// Used by both the static view (paused) and the dynamic view (animated).

const STATIC_COUNTS = [50, 300, 1000, 3000]
const STATIC_X      = [-4.5, -1.5, 1.5, 4.5]

function MultiScene({ shape, modelUrl, size, forcesRef, renderOptsRef, paused, instanceGeoUrl, instanceSize }: {
  shape: ParticleShape; modelUrl: string | null
  size: number
  forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>
  paused: boolean
  instanceGeoUrl?: string | null
  instanceSize?: number
}) {
  const sim0 = useRef<SimData | null>(null)
  const sim1 = useRef<SimData | null>(null)
  const sim2 = useRef<SimData | null>(null)
  const sim3 = useRef<SimData | null>(null)
  const simRefs = [sim0, sim1, sim2, sim3]
  const builtinShape = shape === 'model' ? 'sphere' : shape

  const [instanceGeo, setInstanceGeo] = useState<THREE.BufferGeometry | null>(null)
  const [instanceMat, setInstanceMat] = useState<THREE.Material | null>(null)
  const handleShape = useCallback((geo: THREE.BufferGeometry, mat: THREE.Material) => {
    setInstanceGeo(geo); setInstanceMat(mat)
  }, [])
  useEffect(() => { if (!instanceGeoUrl) { setInstanceGeo(null); setInstanceMat(null) } }, [instanceGeoUrl])

  // Only apply custom shape in static (paused) view
  const activeInstanceGeo = paused ? instanceGeo : null
  const activeInstanceMat = paused ? instanceMat : null

  return (
    <>
      {paused && instanceGeoUrl && (
        <Suspense fallback={null}>
          <InstanceGeoLoader url={instanceGeoUrl} onLoad={handleShape} />
        </Suspense>
      )}
      {STATIC_COUNTS.map((count, i) => (
        <group key={i}>
          {shape === 'model' && modelUrl ? (
            <Suspense fallback={null}>
              <ModelParticles
                url={modelUrl} simRef={simRefs[i]} count={count} size={size}
                forcesRef={forcesRef} renderOptsRef={renderOptsRef}
                paused={paused} xOffset={STATIC_X[i]}
              />
            </Suspense>
          ) : (
            <BuiltinParticles
              shape={builtinShape} simRef={simRefs[i]}
              count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef}
              paused={paused} xOffset={STATIC_X[i]}
              instanceGeo={activeInstanceGeo} instanceMat={activeInstanceMat}
              instanceSize={instanceSize}
            />
          )}
          <Html center position={[STATIC_X[i], -1.7, 0]} style={{ pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', whiteSpace: 'nowrap', userSelect: 'none' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#c0c0e0', letterSpacing: 0.3 }}>
                {count.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: '#8888b8', marginTop: 2 }}>particles</div>
            </div>
          </Html>
        </group>
      ))}
    </>
  )
}

// ── Instance geometry loader (static view only) ───────────────────────────────
// Loads a GLB, extracts the largest mesh, normalises to unit size, calls onLoad.

function InstanceGeoLoader({ url, onLoad }: {
  url: string
  onLoad: (geo: THREE.BufferGeometry, mat: THREE.Material) => void
}) {
  const gltf = useLoader(GLTFLoader, url)
  const cbRef = useRef(onLoad)
  useEffect(() => { cbRef.current = onLoad })
  useEffect(() => {
    let best: THREE.Mesh | null = null; let maxV = 0
    gltf.scene.traverse(n => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.geometry.attributes.position.count > maxV) {
        maxV = m.geometry.attributes.position.count; best = m
      }
    })
    if (!best) return
    const bestMesh = best as THREE.Mesh

    // Clone material (take first if array)
    const srcMat = Array.isArray(bestMesh.material) ? bestMesh.material[0] : bestMesh.material
    const mat = (srcMat as THREE.Material).clone()

    // Clone and normalise geometry
    const geo = bestMesh.geometry.clone()
    geo.computeBoundingBox()
    const c = new THREE.Vector3(); geo.boundingBox!.getCenter(c)
    geo.translate(-c.x, -c.y, -c.z)
    const sz = new THREE.Vector3(); geo.boundingBox!.getSize(sz)
    const s = 2 / Math.max(sz.x, sz.y, sz.z, 0.001)
    const arr = geo.attributes.position.array as Float32Array
    for (let i = 0; i < arr.length; i++) arr[i] *= s
    geo.attributes.position.needsUpdate = true
    geo.computeBoundingBox(); geo.computeBoundingSphere()

    cbRef.current(geo, mat)
  }, [gltf])
  return null
}

// ── Bloom ─────────────────────────────────────────────────────────────────────

function NativeBloom({ strength, threshold }: { strength: number; threshold: number }) {
  const { gl, scene, camera, size } = useThree()
  const composerRef = useRef<EffectComposer | null>(null)
  const bloomRef    = useRef<UnrealBloomPass | null>(null)

  useEffect(() => {
    const composer = new EffectComposer(gl)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), strength, 0.5, threshold)
    composer.addPass(bloom); composer.addPass(new OutputPass())
    composerRef.current = composer; bloomRef.current = bloom
    return () => { composer.dispose() }
  }, [gl, scene, camera]) // eslint-disable-line

  useEffect(() => { composerRef.current?.setSize(size.width, size.height) }, [size])
  useEffect(() => { if (bloomRef.current) { bloomRef.current.strength = strength; bloomRef.current.threshold = threshold } }, [strength, threshold])
  useFrame(() => { composerRef.current?.render() }, 1)
  return null
}

// ── Bloom controller (reads from ref to avoid full Canvas remount) ─────────────

function BloomController({ renderOptsRef }: { renderOptsRef: React.MutableRefObject<RenderOpts> }) {
  const [on,  setOn]  = useState(renderOptsRef.current.bloomOn)
  const [int, setInt] = useState(renderOptsRef.current.bloomInt)
  useFrame(() => {
    const { bloomOn, bloomInt } = renderOptsRef.current
    if (bloomOn !== on)  setOn(bloomOn)
    if (bloomInt !== int) setInt(bloomInt)
  })
  if (!on) return null
  return <NativeBloom strength={int} threshold={0.15} />
}

// ── Dynamic preset cycler (auto-cycles force presets for Dynamic view) ─────────

function DynamicForcesCycler({ forcesRef }: { forcesRef: React.MutableRefObject<Forces> }) {
  const elapsed = useRef(0)
  const idx     = useRef(0)
  useFrame((_, delta) => {
    elapsed.current += delta
    if (elapsed.current > 3.5) {
      elapsed.current = 0
      idx.current = (idx.current + 1) % FORCE_PRESET_KEYS.length
      Object.assign(forcesRef.current, FORCE_PRESETS[FORCE_PRESET_KEYS[idx.current]])
    }
  })
  return null
}

// ── Pollution preset (lungs + PM2.5 particle cloud) ────────────────────────────
// A lungs model sits at the centre; a particle cloud flows through it. Each city's
// PM2.5 drives BOTH the cloud density (count) and its flow speed — more pollution
// ⇒ more, faster particles. Works in the static view (cities side-by-side) and
// the dynamic/effect views (one lungs cycling through the cities).

// Bundled lungs model — offered as a Center-model choice (the air-pollution example).
const POLLUTION_MODEL_URL = import.meta.env.BASE_URL + 'assets/models/lungs_-_normal_study.glb'

// Adjustable cloud options (exposed in the panel so the example is reproducible).
// `cycle` = step the Dynamic view through each data row (the "example" arrangement);
// off by default so picking a model just shows one calm cloud.
interface CloudOpts { modelUrl: string; size: number; spread: number; low: string; high: string; cycle: boolean }
const CLOUD_DEFAULTS = { size: 0.013, spread: 1.0, low: '#3ec46f', high: '#e23b3b' }
// Central-model choices for the data cloud: lungs (default) + the model presets.
const CLOUD_MODELS = [{ name: 'Lungs', url: POLLUTION_MODEL_URL }, ...MODEL_PRESETS]

// PM2.5 → cloud density and flow speed (more pollution ⇒ more, faster particles).
const pollutionCount = (pm: number) => Math.round(Math.min(Math.max(pm * 13.5, 50), 1800))
const pollutionSpeed = (pm: number) => 0.5 + pm * 0.03

// Two-colour gradient, clean → polluted (HSL lerp keeps it smooth and saturated).
function rampColor(t: number, low: string, high: string) {
  return new THREE.Color(low).lerpHSL(new THREE.Color(high), Math.min(Math.max(t, 0), 1))
}
// Even 0..1 tone per city, ordered by PM2.5 rank (robust to data order & gaps).
function cityTones(cities: DataRow[]): number[] {
  const order = cities.map((c, i) => ({ v: c.value, i })).sort((a, b) => a.v - b.v)
  const tones = new Array<number>(cities.length).fill(0)
  order.forEach((o, rank) => { tones[o.i] = cities.length > 1 ? rank / (cities.length - 1) : 0 })
  return tones
}

const POLL_LABEL: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap', textAlign: 'center',
  background: 'rgba(0,0,0,0.52)', padding: '3px 12px', borderRadius: 4, userSelect: 'none',
}

// Renders null instead of crashing if the lungs model is missing/unreadable.
class SafeModel extends Component<{ children: React.ReactNode }, { err: boolean }> {
  state = { err: false }
  static getDerivedStateFromError() { return { err: true } }
  render() { return this.state.err ? null : this.props.children }
}

// Central lungs mesh — normalised to ~2.2 units and centred at (xOffset, 0, 0).
function LungsMesh({ url, xOffset }: { url: string; xOffset: number }) {
  const gltf = useLoader(GLTFLoader, url)
  const obj = useMemo(() => {
    const s    = gltf.scene.clone(true)
    const box  = new THREE.Box3().setFromObject(s)
    const ctr  = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const scale = 2.2 / Math.max(size.x, size.y, size.z, 0.001)
    s.scale.setScalar(scale)
    s.position.set(xOffset - ctr.x * scale, -ctr.y * scale, -ctr.z * scale)
    // Make the lungs translucent so the particle cloud reads through them.
    s.traverse(n => {
      const m = n as THREE.Mesh
      if (!m.isMesh || !m.material) return
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      mats.forEach(mm => {
        const mat = mm as THREE.MeshStandardMaterial
        mat.transparent = true
        mat.opacity     = 0.28
        mat.depthWrite  = false
        mat.side        = THREE.DoubleSide
        mat.needsUpdate = true
      })
    })
    return s
  }, [gltf, xOffset])
  return <primitive object={obj} />
}

// Particle cloud of tiny spheres that oscillate through the lungs' centre — like
// electrons swinging in and out through the nucleus (they penetrate the centre and
// never drift away). Each has its own turbulent wander so no two paths match, and
// trails a short fading trajectory line. `count`/`speed` come from the city's
// PM2.5: more pollution ⇒ more particles, oscillating faster.
const CLOUD_A_MIN   = 0.6     // min oscillation amplitude (stays near the centre)
const CLOUD_A_MAX   = 2.1     // max amplitude (plunges through the far side of the lungs)
const TRAIL_SAMPLES = 8       // length of the trajectory line (frames of history)
const TURB_FREQ     = 1.3     // spatial scale of the swirl
const TURB_SPEED    = 0.7     // how fast the swirl evolves

function PollutionCloud({ count, speed, tone, xOffset, playSpeed = 1, size, spread, low, high }: {
  count: number; speed: number; tone: number; xOffset: number; playSpeed?: number
  size: number; spread: number; low: string; high: string
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const geo     = useMemo(() => new THREE.SphereGeometry(1, 10, 10), [])
  const color   = useMemo(() => rampColor(tone, low, high), [tone, low, high])
  const tAcc    = useRef(0)   // playback-speed-scaled clock (no jumps on change)

  // Per-particle oscillation: a random axis through the centre (amplitude A,
  // angular freq ω scaled by pollution speed, phase φ) → centre + axis·A·cos(ωt+φ),
  // which sweeps THROUGH the centre. A shared swirl field (below) adds turbulence.
  const osc = useMemo(() => {
    const dir = new Float32Array(count * 3)
    const amp = new Float32Array(count)
    const omg = new Float32Array(count)
    const pha = new Float32Array(count)
    const baseFreq = 1.0 + speed * 1.3
    for (let i = 0; i < count; i++) {
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1
      const L = Math.hypot(dx, dy, dz) || 1
      dir[i*3] = dx / L; dir[i*3+1] = dy / L; dir[i*3+2] = dz / L
      // Bias toward smaller amplitudes so the cloud concentrates near the centre,
      // with a few particles reaching far enough to punch through the lungs.
      // `spread` scales how far the cloud reaches out.
      amp[i] = (CLOUD_A_MIN + Math.pow(Math.random(), 1.7) * (CLOUD_A_MAX - CLOUD_A_MIN)) * spread
      omg[i] = baseFreq * (0.7 + Math.random() * 0.6)
      pha[i] = Math.random() * Math.PI * 2
    }
    return { dir, amp, omg, pha }
  }, [count, speed, spread])

  // Swirl angle (radians) — differential rotation about the centre. Scales a
  // little with pollution.
  const turbAmp = 0.5 + speed * 0.2

  // Ring buffer of recent positions + line geometry for the trails.
  const trail = useMemo(() => ({
    hist: new Float32Array(count * TRAIL_SAMPLES * 3),
    head: 0, inited: false,
  }), [count])
  const lineGeo = useMemo(() => {
    const segs = TRAIL_SAMPLES - 1
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * segs * 2 * 3), 3))
    g.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(count * segs * 2 * 3), 3))
    return g
  }, [count])

  useFrame((_, delta) => {
    const mesh = meshRef.current
    if (!mesh) return
    tAcc.current += delta * playSpeed
    const tt = tAcc.current
    const { dir, amp, omg, pha } = osc
    const T = TRAIL_SAMPLES, hist = trail.hist, head = trail.head
    const ts = tt * TURB_SPEED

    // 1) Positions → instances + history ring buffer.
    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const d = Math.cos(omg[i] * tt + pha[i]) * amp[i]   // signed → passes through the centre
      // Offset from the (fixed) centre.
      const rx = dir[i3] * d, ry = dir[i3+1] * d, rz = dir[i3+2] * d
      // Turbulence as differential rotation ABOUT the centre: swirl that never
      // moves the centre and never flings particles outward (radius is preserved).
      const aY = Math.sin(ry * TURB_FREQ + ts) * turbAmp
      const cY = Math.cos(aY), sY = Math.sin(aY)
      const x1 = rx * cY - rz * sY, z1 = rx * sY + rz * cY
      const aX = Math.cos(rz * TURB_FREQ + ts * 0.8) * turbAmp
      const cX = Math.cos(aX), sX = Math.sin(aX)
      const px = xOffset + x1
      const py = ry * cX - z1 * sX
      const pz = ry * sX + z1 * cX
      _dummy.position.set(px, py, pz)
      _dummy.quaternion.set(0, 0, 0, 1)
      _dummy.scale.setScalar(size)
      _dummy.updateMatrix()
      mesh.setMatrixAt(i, _dummy.matrix)
      if (!trail.inited) {                     // first frame: seed whole history at current pos
        for (let s = 0; s < T; s++) { const b = (i*T + s)*3; hist[b]=px; hist[b+1]=py; hist[b+2]=pz }
      } else {
        const b = (i*T + head)*3; hist[b]=px; hist[b+1]=py; hist[b+2]=pz
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    trail.inited = true

    // 2) Build fading line segments from the history (newest = brightest).
    const posAttr = lineGeo.attributes.position as THREE.BufferAttribute
    const colAttr = lineGeo.attributes.color    as THREE.BufferAttribute
    const lp = posAttr.array as Float32Array, lc = colAttr.array as Float32Array
    const segs = T - 1, cr = color.r, cg = color.g, cb = color.b
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < segs; j++) {
        const s0 = (head - j + T) % T, s1 = (head - j - 1 + T) % T
        const a = (i*T + s0)*3, bb = (i*T + s1)*3
        const base = (i*segs + j) * 6
        lp[base]   = hist[a];   lp[base+1] = hist[a+1]; lp[base+2] = hist[a+2]
        lp[base+3] = hist[bb];  lp[base+4] = hist[bb+1]; lp[base+5] = hist[bb+2]
        const f0 = (1 - j / segs) * 0.7, f1 = (1 - (j + 1) / segs) * 0.7
        lc[base]   = cr*f0; lc[base+1] = cg*f0; lc[base+2] = cb*f0
        lc[base+3] = cr*f1; lc[base+4] = cg*f1; lc[base+5] = cb*f1
      }
    }
    posAttr.needsUpdate = true; colAttr.needsUpdate = true
    trail.head = (head + 1) % T
  })

  return (
    <group>
      <instancedMesh key={`${count}|${xOffset}`} ref={meshRef} args={[undefined, undefined, count]}>
        <primitive object={geo} attach="geometry" />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.18} roughness={0.5} metalness={0.1} />
      </instancedMesh>
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial vertexColors transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </lineSegments>
    </group>
  )
}

// One city: the central model (graceful if missing) + its pollution cloud.
function CityUnit({ pm25, tone, xOffset, playSpeed = 1, cloud }: {
  pm25: number; tone: number; xOffset: number; playSpeed?: number; cloud: CloudOpts
}) {
  return (
    <group>
      <SafeModel>
        <Suspense fallback={null}>
          <LungsMesh url={cloud.modelUrl} xOffset={xOffset} />
        </Suspense>
      </SafeModel>
      <PollutionCloud count={pollutionCount(pm25)} speed={pollutionSpeed(pm25)} tone={tone} xOffset={xOffset}
        playSpeed={playSpeed} size={cloud.size} spread={cloud.spread} low={cloud.low} high={cloud.high} />
    </group>
  )
}

function PollutionLabel({ city, xOffset, y = -2.5, scale = 1 }: {
  city: DataRow; xOffset: number; y?: number; scale?: number
}) {
  return (
    <Html center position={[xOffset, y, 0]} style={{ pointerEvents: 'none' }}>
      <div style={POLL_LABEL}>
        <div style={{ fontSize: 17 * scale, fontWeight: 600, color: '#e0e0f0', letterSpacing: 0.3 }}>{city.category}</div>
        <div style={{ fontSize: 14 * scale, color: '#c8a08a', fontVariantNumeric: 'tabular-nums' }}>{city.value} µg/m³ · {pollutionCount(city.value).toLocaleString()} particles</div>
      </div>
    </Html>
  )
}

// Static view: every city side-by-side, each animating.
function PollutionMulti({ cities, cloud }: { cities: DataRow[]; cloud: CloudOpts }) {
  const n = cities.length, spacing = 3.4, offset = (n - 1) / 2
  const tones = cityTones(cities)
  return (
    <>
      {cities.map((c, i) => {
        const x = (i - offset) * spacing
        return (
          <group key={i}>
            <CityUnit pm25={c.value} tone={tones[i]} xOffset={x} cloud={cloud} />
            <PollutionLabel city={c} xOffset={x} />
          </group>
        )
      })}
    </>
  )
}

// Dynamic / effect view, cycle OFF: ONE model + ONE cloud — the tunable building
// block. Represents the dataset as a whole (count/speed from the average value);
// no cycling/clusters, so picking a model doesn't jump to the finished look.
function PollutionSingle({ cities, playSpeed = 1, cloud }: {
  cities: DataRow[]; playSpeed?: number; cloud: CloudOpts
}) {
  const avg = cities.reduce((s, c) => s + c.value, 0) / Math.max(cities.length, 1)
  return <CityUnit pm25={avg} tone={0.5} xOffset={0} playSpeed={playSpeed} cloud={cloud} />
}

// Dynamic / effect view, cycle ON: one lungs, stepping through each row every few
// seconds with its label — the saved "example" arrangement.
function PollutionCycle({ cities, playSpeed = 1, showLabels = true, cloud }: {
  cities: DataRow[]; playSpeed?: number; showLabels?: boolean; cloud: CloudOpts
}) {
  const [idx, setIdx] = useState(0)
  const elapsed = useRef(0), idxRef = useRef(0)
  const tones = cityTones(cities)
  useFrame((_, delta) => {
    elapsed.current += delta * playSpeed
    if (elapsed.current > 3.5) {
      elapsed.current = 0
      idxRef.current = (idxRef.current + 1) % Math.max(cities.length, 1)
      setIdx(idxRef.current)
    }
  })
  const city = cities[idx] ?? cities[0]
  if (!city) return null
  return (
    <>
      {/* key by idx so the cloud re-seeds at the new row's count/speed */}
      <CityUnit key={idx} pm25={city.value} tone={tones[idx] ?? 0} xOffset={0} playSpeed={playSpeed} cloud={cloud} />
      {showLabels && <PollutionLabel city={city} xOffset={0} y={-1.7} scale={1.18} />}
    </>
  )
}

function PollutionScene({ view, data, playSpeed = 1, showLabels = true, cloud }: {
  view: ViewType; data: DataRow[]; playSpeed?: number; showLabels?: boolean; cloud: CloudOpts
}) {
  const cities = data.filter(d => d.value != null)
  if (!cities.length) return null
  // Compare (static) keeps its own pacing/labels; the playback options only steer
  // the dynamic single-lungs view.
  if (view === 'static') return <PollutionMulti cities={cities} cloud={cloud} />
  // Dynamic: cycle through rows (the saved example) or show one calm cloud.
  return cloud.cycle
    ? <PollutionCycle cities={cities} playSpeed={playSpeed} showLabels={showLabels} cloud={cloud} />
    : <PollutionSingle cities={cities} playSpeed={playSpeed} cloud={cloud} />
}

// Frames the pollution scene: sets camera distance + fov (independent of the view
// the Canvas first mounted in).
function SceneCamera({ dist, fov }: { dist: number; fov: number }) {
  const { camera } = useThree()
  useEffect(() => {
    camera.position.set(0, 0, dist)
    const pc = camera as THREE.PerspectiveCamera
    if (pc.isPerspectiveCamera) pc.fov = fov
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [camera, dist, fov])
  return null
}

// ── Scene assembly ────────────────────────────────────────────────────────────

function SceneContent({ shape, modelUrl, count, size, forcesRef, renderOptsRef, paused, speedRef }: {
  shape: ParticleShape; modelUrl: string | null
  count: number; size: number
  forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>
  paused?: boolean
  speedRef?: React.MutableRefObject<number>
}) {
  const simRef   = useRef<SimData | null>(null)
  const trailKey = `${shape}-${modelUrl ?? ''}-${count}`
  const [trailOn,  setTrailOn]  = useState(renderOptsRef.current.trailOn)
  const [trailLen, setTrailLen] = useState(renderOptsRef.current.trailLen)
  useFrame(() => {
    const { trailOn: to, trailLen: tl } = renderOptsRef.current
    if (to !== trailOn)  setTrailOn(to)
    if (tl !== trailLen) setTrailLen(tl)
  })

  return (
    <>
      {(shape === 'sphere' || shape === 'cube') && (
        <BuiltinParticles shape={shape} simRef={simRef} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} paused={paused} speedRef={speedRef} />
      )}
      {shape === 'model' && modelUrl && (
        <Suspense fallback={null}>
          <ModelParticles url={modelUrl} simRef={simRef} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} paused={paused} speedRef={speedRef} />
        </Suspense>
      )}
      {trailOn && !paused && (
        <TrailRenderer key={trailKey+trailLen} simRef={simRef} count={count} trailLen={trailLen} renderOptsRef={renderOptsRef} />
      )}
    </>
  )
}

// ── Per-view canvas ───────────────────────────────────────────────────────────

function ViewCanvas({ viewType, shape, modelUrl, count, size, forcesRef, renderOptsRef, instanceGeoUrl, instanceSize, pollution, cloud, data, playSpeed = 1, speedRef, showLabels = true }: {
  viewType: ViewType; shape: ParticleShape; modelUrl: string | null
  count: number; size: number
  forcesRef: React.MutableRefObject<Forces>
  renderOptsRef: React.MutableRefObject<RenderOpts>
  instanceGeoUrl?: string | null
  instanceSize?: number
  pollution?: boolean
  cloud: CloudOpts
  data?: DataRow[]
  playSpeed?: number
  speedRef?: React.MutableRefObject<number>
  showLabels?: boolean
}) {
  const dynamicForcesRef = useRef<Forces>({ ...FORCE_PRESETS.Swarm })
  const isStatic  = viewType === 'static'
  const isDynamic = viewType === 'dynamic'
  const isMulti   = isStatic || isDynamic

  // Pollution preset frames a wider row in the static view.
  const cityCount = data?.filter(d => d.value != null).length ?? 5
  const pollDist  = isStatic ? Math.max(10, cityCount * 3.6) : 6.5

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        camera={isMulti ? { position: [0, 0, 9], fov: 60 } : { position: [0, 0, 5], fov: 50 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}
        style={{ background: '#000000' }}
      >
        <OrbitControls makeDefault />
        {pollution ? (
          <>
            {/* Neutral lighting so the lungs read naturally. */}
            <ambientLight intensity={0.65} />
            <directionalLight position={[3, 5, 4]} intensity={1.1} />
            <directionalLight position={[-4, -2, -3]} intensity={0.4} color="#88aaff" />
            <SceneCamera dist={pollDist} fov={55} />
            <PollutionScene view={viewType} data={data ?? []} playSpeed={playSpeed} showLabels={showLabels} cloud={cloud} />
          </>
        ) : (
          <>
            <ambientLight intensity={0.1} />
            <pointLight position={[0,  4,  0]} intensity={1.2} color="#6666ff" />
            <pointLight position={[4, -2,  2]} intensity={0.7} color="#ff8844" />
            <pointLight position={[-4, 0, -3]} intensity={0.5} color="#44ffaa" />
            {isMulti ? (
              <MultiScene
                shape={shape} modelUrl={modelUrl} size={size}
                forcesRef={isDynamic ? dynamicForcesRef : forcesRef}
                renderOptsRef={renderOptsRef}
                paused={isStatic}
                instanceGeoUrl={instanceGeoUrl}
                instanceSize={instanceSize}
              />
            ) : (
              <SceneContent
                shape={shape} modelUrl={modelUrl} count={count} size={size}
                forcesRef={forcesRef} renderOptsRef={renderOptsRef}
                paused={false} speedRef={speedRef}
              />
            )}
            {isDynamic && <DynamicForcesCycler forcesRef={dynamicForcesRef} />}
          </>
        )}
        <BloomController renderOptsRef={renderOptsRef} />
      </Canvas>
    </div>
  )
}

// ── Local UI helpers ──────────────────────────────────────────────────────────

function SegBtn({ active, onClick, children, small }: {
  active?: boolean; onClick: () => void; children: React.ReactNode; small?: boolean
}) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: small ? '5px 0' : '7px 0',
      fontSize: small ? 10 : 10, borderRadius: 6, cursor: 'pointer',
      background: active ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
      color:      active ? 'var(--lab-accent)' : 'var(--lab-text-2)',
      border:     active ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
      fontWeight: active ? 600 : 400, fontFamily: 'inherit',
      transition: 'background 0.1s, color 0.1s, border-color 0.1s',
    }}>{children}</button>
  )
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <div style={{ width: 28, height: 16, borderRadius: 8, position: 'relative', background: on ? 'var(--lab-accent)' : 'var(--lab-divider)', border: `1px solid ${on ? 'var(--lab-accent)' : 'var(--lab-border)'}`, transition: 'background .2s' }}>
        <div style={{ position: 'absolute', top: 2, left: on ? 11 : 2, width: 10, height: 10, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left .2s' }} />
      </div>
      <span style={{ fontSize: 11, color: on ? 'var(--lab-accent)' : 'var(--lab-text-2)' }}>{label}</span>
    </div>
  )
}

// ── Force sliders config ──────────────────────────────────────────────────────

const FORCE_SLIDERS: [string, keyof Forces, number, number, number][] = [
  ['Gravity',    'gravity',    0,  4, 0.05],
  ['Turbulence', 'turbulence', 0,  5, 0.1 ],
  ['Vortex',     'vortex',    -4,  4, 0.1 ],
  ['Attraction', 'attraction', 0,  5, 0.1 ],
  ['Damping',    'damping',    0,  5, 0.1 ],
  ['Emit Speed', 'emitSpeed',  0,  3, 0.05],
]

// ── ParticleLab ───────────────────────────────────────────────────────────────

export default function ParticleLab({ embedded, initialPresetId, presetHandleRef, presetSlot }: {
  embedded?: boolean
  initialPresetId?: string
  presetHandleRef?: { current: LabPresetHandle | null }
  presetSlot?: React.ReactNode
} = {}) {
  const [shape,          setShape]          = useState<ParticleShape>('sphere')
  const [fileName,       setFileName]       = useState('')
  const [modelUrl,       setModelUrl]       = useState<string | null>(null)
  const [instanceGeoUrl,  setInstanceGeoUrl]  = useState<string | null>(null)
  const [instanceGeoName, setInstanceGeoName] = useState('')
  const [instanceSize,    setInstanceSize]    = useState(0.3)
  const [count,    setCount]    = useState(3000)
  const [size,     setSize]     = useState(0.04)
  const [forces,   setForces]   = useState<Forces>(DEFAULT_FORCES)
  const [render,   setRender]   = useState<RenderOpts>(DEFAULT_RENDER)

  const forcesRef     = useRef<Forces>(forces)
  const renderOptsRef = useRef<RenderOpts>(render)
  useEffect(() => { forcesRef.current = forces },     [forces])
  useEffect(() => { renderOptsRef.current = render }, [render])

  // Dynamic/Compare view + playback options. Dynamic = the single animated system
  // (pollution preset: one lungs cycling through cities); Compare = the paused
  // side-by-side comparison. Smooth/transition doesn't apply to particles.
  const [view,       setView]       = useState<LabView>('dynamic')
  const [showLabels, setShowLabels] = useState(true)
  const [animSpeed,  setAnimSpeed]  = useState(1.0)
  const animSpeedRef = useRef(1.0)
  useEffect(() => { animSpeedRef.current = animSpeed }, [animSpeed])
  const view1: ViewType = view === 'compare' ? 'static' : 'effect'
  // const [view2, setView2] = useState<ViewType | null>(null)
  const [showAdvanced,    setShowAdvanced]    = useState(false)


  const [data, setData] = useState<DataRow[]>(DEFAULT_DATA)
  // The data cloud is driven by the CENTER MODEL, not the dataset: pick a central
  // model and the particle cloud forms around it (count/speed from the data). No
  // model by default → generic particle sandbox. The air-pollution preset restores
  // the lungs model + its dataset, so loading it brings the example back.
  const [cloudModelUrl,  setCloudModelUrl]  = useState<string | null>(null)
  const [cloudModelName, setCloudModelName] = useState('')
  const [cloudSize,      setCloudSize]      = useState(CLOUD_DEFAULTS.size)
  const [cloudSpread,    setCloudSpread]    = useState(CLOUD_DEFAULTS.spread)
  const [cloudLow,       setCloudLow]       = useState(CLOUD_DEFAULTS.low)
  const [cloudHigh,      setCloudHigh]      = useState(CLOUD_DEFAULTS.high)
  const [cloudCycle,     setCloudCycle]     = useState(false)  // step Dynamic through rows
  const cloudMode = cloudModelUrl != null
  const cloud: CloudOpts = { modelUrl: cloudModelUrl ?? '', size: cloudSize, spread: cloudSpread, low: cloudLow, high: cloudHigh, cycle: cloudCycle }
  // Reference is derived from the current dataset (not the preset): choosing a
  // dataset with a reference shows its card, auto-opening when it changes.
  const reference = useMemo(() => referenceForData(data), [data])
  const [showReference, setShowReference] = useState(false)
  useEffect(() => { setShowReference(!!reference) }, [reference])
  const [dataColumns,   setDataColumns]   = useState<ColumnMeta[] | undefined>(undefined)
  const [draggingField, setDraggingField] = useState<DataField | null>(null)
  const [presets,       setPresets]       = useState<SceneSave[]>(() => loadPresets())
  const [selPresetId,   setSelPresetId]   = useState('')
  const [saveName,      setSaveName]      = useState<string | null>(null)

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
    if (modelUrl) URL.revokeObjectURL(modelUrl)
    setModelUrl(URL.createObjectURL(file))
    setFileName(file.name); setShape('model')
  }, [modelUrl])

  const setF = (k: keyof Forces) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForces(f => ({ ...f, [k]: Number(e.target.value) }))
  const setR = <K extends keyof RenderOpts>(k: K, v: RenderOpts[K]) =>
    setRender(r => ({ ...r, [k]: v }))

  const savePreset = useCallback((name: string) => {
    const save: SceneSave = {
      id: Date.now().toString(), name, createdAt: new Date().toISOString(),
      // Cloud mode is derived from the dataset (dataRows), not stored as a flag.
      data: { shape, fileName, count, size, forces: { ...forces }, render: { ...render }, dataRows: data,
              cloud: { ...cloud, name: cloudModelName } },
    }
    const next = [save, ...presets]
    setPresets(next); persistPresets(next); setSelPresetId(save.id); setSaveName(null)
    return save
  }, [shape, fileName, count, size, forces, render, data, cloudModelUrl, cloudModelName, cloudSize, cloudSpread, cloudLow, cloudHigh, cloudCycle, presets])

  const loadPreset = useCallback((id: string) => {
    const p = presets.find(x => x.id === id) ?? bundledLabPresets('particles').find(x => x.id === id); if (!p) return
    const d = p.data as Record<string, unknown>
    if (d.shape) setShape(d.shape as ParticleShape)
    if (d.count  != null) setCount(d.count as number)
    if (d.size   != null) setSize(d.size as number)
    if (d.forces) setForces({ ...DEFAULT_FORCES, ...(d.forces as Partial<Forces>) })
    if (d.render) setRender({ ...DEFAULT_RENDER, ...(d.render as Partial<RenderOpts>) })
    if (d.fileName) setFileName(d.fileName as string)
    // Restore the cloud: the central model (which turns the cloud on) + appearance.
    // Always set the model explicitly (null = none) so a no-model preset clears it.
    const c = d.cloud as (Partial<CloudOpts> & { name?: string }) | undefined
    if (c) {
      setCloudModelUrl(c.modelUrl ? c.modelUrl : null)
      setCloudModelName(c.name ?? '')
      if (c.size   != null) setCloudSize(c.size)
      if (c.spread != null) setCloudSpread(c.spread)
      if (c.low)  setCloudLow(c.low)
      if (c.high) setCloudHigh(c.high)
      if (c.cycle != null) setCloudCycle(c.cycle)
    }
    // Re-link the saved rows to their canonical dataset (by content) so the
    // reference + dataset variables come back; otherwise use the rows as-is.
    const savedRows = d.dataRows as DataRow[] | undefined
    const ds = savedRows ? matchDataset(savedRows) : null
    if (ds)             { setData(ds.data); setDataColumns(ds.columns) }
    else if (savedRows) { setData(savedRows); setDataColumns(DATASET_GENERIC.columns) }
    // Legacy pollution presets (saved before these fields): seed the lungs + cycle
    // so the example's Dynamic view still steps through the cities.
    if (ds === DATASET_POLLUTION) {
      if (!c)               { setCloudModelUrl(POLLUTION_MODEL_URL); setCloudModelName('Lungs') }
      if (!c || c.cycle == null) setCloudCycle(true)
    }
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

  return (
    <div style={{ display: 'flex', height: embedded ? '100%' : '100vh', fontFamily: 'system-ui, sans-serif', background: 'var(--lab-fill)', color: 'var(--lab-text)', position: 'relative' }}>



      {/* ── Left panel ── */}
      <div style={{ width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--lab-border)', background: 'var(--lab-surface)', position: 'relative' }}>

        <LabAdvancedToggle open={showAdvanced} onToggle={() => setShowAdvanced(v => !v)} />

        <div style={{ flex: 1, padding: embedded ? '52px 16px 18px' : '18px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>

          {!embedded && <LabNavTitle name="Particle Lab" href="/particles" />}

          {/* Embedded in the hub, the global preset dropdown replaces this row. */}
          {!embedded && (
            <LabPresetRow
              presets={presets} selPresetId={selPresetId} saveName={saveName}
              defaultSaveName={`Particles ${new Date().toLocaleDateString()}`}
              onSelect={loadPreset} onSave={savePreset} onDelete={() => deletePreset(selPresetId)}
              setSaveName={setSaveName} setSelPresetId={setSelPresetId}
            />
          )}

          {/* Particles — one section: Count/Size for the sim, Size/Spread for the cloud */}
          <Sec>
            <SLabel>Particles</SLabel>
            {!cloudMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <RowLabel>Count: {count.toLocaleString()}</RowLabel>
                <input type="range" min={200} max={8000} step={100} value={count} onChange={e => setCount(Number(e.target.value))} style={sl} />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Size: {(cloudMode ? cloudSize : size).toFixed(3)}</RowLabel>
              {cloudMode
                ? <input type="range" min={0.005} max={0.04} step={0.001} value={cloudSize} onChange={e => setCloudSize(Number(e.target.value))} style={sl} />
                : <input type="range" min={0.01}  max={0.15} step={0.005} value={size}      onChange={e => setSize(Number(e.target.value))}      style={sl} />}
            </div>
            {cloudMode && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <RowLabel>Spread: {cloudSpread.toFixed(2)}×</RowLabel>
                  <input type="range" min={0.4} max={2} step={0.05} value={cloudSpread} onChange={e => setCloudSpread(Number(e.target.value))} style={sl} />
                </div>
                <div style={{ marginTop: 2 }}>
                  <Toggle on={cloudCycle} onClick={() => setCloudCycle(v => !v)} label="Cycle through data (Dynamic)" />
                </div>
              </>
            )}
          </Sec>

          {/* Effect / quick force presets */}
          <Sec>
            <SLabel>Effect</SLabel>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {FORCE_PRESET_KEYS.map(name => (
                <button key={name} onClick={() => setForces({ ...FORCE_PRESETS[name] })} style={{
                  padding: '5px 11px', fontSize: 10, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                  background: 'var(--lab-fill)', color: 'var(--lab-text-2)', border: '1px solid var(--lab-border)',
                }}>{name}</button>
              ))}
            </div>
          </Sec>

          {/* Source (sphere/cube + GLB drop) — commented out */}
          {false && (
          <Sec>
            <SLabel>Source</SLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <SegBtn active={shape==='sphere'} onClick={() => setShape('sphere')}>Sphere</SegBtn>
              <SegBtn active={shape==='cube'}   onClick={() => setShape('cube')}>Cube</SegBtn>
            </div>
            <div
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              onDragOver={e => e.preventDefault()}
              onClick={() => document.getElementById('glb-particle-input')!.click()}
              style={{
                border: `1px dashed ${shape === 'model' ? 'var(--lab-accent)' : 'var(--lab-border)'}`,
                borderRadius: 8, padding: '14px 10px', textAlign: 'center',
                cursor: 'pointer', fontSize: 11,
                color: shape === 'model' ? 'var(--lab-accent)' : 'var(--lab-text-3)', background: 'var(--lab-surface)',
              }}
            >
              {fileName || 'Drop GLB or click to browse'}
            </div>
            <input id="glb-particle-input" type="file" accept=".glb,.gltf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          </Sec>
          )}

          {/* Forces */}
          <Sec>
            <SLabel>Forces</SLabel>
            {FORCE_SLIDERS.map(([label, key, min, max, step]) => (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <RowLabel>{label}: {forces[key].toFixed(2)}</RowLabel>
                <input type="range" min={min} max={max} step={step} value={forces[key]} onChange={setF(key)} style={sl} />
              </div>
            ))}
          </Sec>

          {/* Center model — pick one to form the data cloud around it (none by default) */}
          <Sec>
            <SLabel>Center model</SLabel>
            <select value={cloudModelName || '__none__'}
              onChange={e => {
                const v = e.target.value
                if (v === '__none__')   { setCloudModelUrl(null); setCloudModelName(''); return }
                if (v === '__upload__') { document.getElementById('cloud-model-input')!.click(); return }
                const m = CLOUD_MODELS.find(mm => mm.name === v)
                if (m) { setCloudModelUrl(m.url); setCloudModelName(m.name) }
              }}
              style={{ width: '100%', background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', color: cloudModelName ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 11, padding: '6px 8px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
              <option value="__none__">None</option>
              {CLOUD_MODELS.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              {cloudModelName && !CLOUD_MODELS.some(m => m.name === cloudModelName) && <option value={cloudModelName}>{cloudModelName}</option>}
              <option value="__upload__">Upload custom GLB…</option>
            </select>
            <input id="cloud-model-input" type="file" accept=".glb,.gltf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (!f) return; setCloudModelUrl(URL.createObjectURL(f)); setCloudModelName(f.name) }} />
          </Sec>

        </div>

        {/* Global preset row (hub) sits just above the data panel when embedded. */}
        {embedded && presetSlot && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--lab-border)', background: 'var(--lab-surface)' }}>
            {presetSlot}
          </div>
        )}

        <LabDataPanel data={data} columnsOverride={dataColumns} onDataChange={setData} />
      </div>

      {/* ── Advanced panel ── */}
      <LabAdvancedPanel open={showAdvanced}>
        {cloudMode ? (
          <Sec>
            <SLabel>Cloud colors</SLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="color" value={cloudLow} onChange={e => setCloudLow(e.target.value)}
                style={{ width: 32, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--lab-text-2)' }}>Clean · {cloudLow}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="color" value={cloudHigh} onChange={e => setCloudHigh(e.target.value)}
                style={{ width: 32, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--lab-text-2)' }}>Polluted · {cloudHigh}</span>
            </div>
          </Sec>
        ) : (<>
        <Sec>
          <SLabel>Color</SLabel>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {(['speed','heat','rainbow','solid'] as ColorMode[]).map(m => (
              <SegBtn key={m} small active={render.colorMode===m} onClick={() => setR('colorMode', m)}>
                {m[0].toUpperCase()+m.slice(1)}
              </SegBtn>
            ))}
          </div>
          {render.colorMode === 'solid' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="color" value={render.solidColor} onChange={e => setR('solidColor', e.target.value)}
                style={{ width: 32, height: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} />
              <span style={{ fontSize: 10, color: 'var(--lab-text-2)' }}>{render.solidColor}</span>
            </div>
          )}
        </Sec>

        <Sec>
          <SLabel>Blending</SLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            <SegBtn active={render.blending==='standard'} onClick={() => setR('blending','standard')}>Standard</SegBtn>
            <SegBtn active={render.blending==='additive'} onClick={() => setR('blending','additive')}>Additive ✦</SegBtn>
          </div>
        </Sec>

        <Sec>
          <SLabel>Brightness</SLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <RowLabel>×{render.brightness.toFixed(1)}</RowLabel>
            <input type="range" min={0.3} max={5} step={0.05} value={render.brightness}
              onChange={e => setR('brightness', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
          </div>
        </Sec>

        <Sec>
          <SLabel>Trails</SLabel>
          <Toggle on={render.trailOn} onClick={() => setR('trailOn', !render.trailOn)} label="Enable trails" />
          {render.trailOn && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <RowLabel>Length: {render.trailLen}</RowLabel>
                <input type="range" min={3} max={150} step={1} value={render.trailLen}
                  onChange={e => setR('trailLen', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <RowLabel>Size: {render.trailSize.toFixed(2)}</RowLabel>
                <input type="range" min={0.1} max={3} step={0.05} value={render.trailSize}
                  onChange={e => setR('trailSize', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
              </div>
            </>
          )}
        </Sec>

        <Sec>
          <SLabel>Bloom</SLabel>
          <Toggle on={render.bloomOn} onClick={() => setR('bloomOn', !render.bloomOn)} label="Enable bloom" />
          {render.bloomOn && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <RowLabel>Intensity: {render.bloomInt.toFixed(2)}</RowLabel>
              <input type="range" min={0.1} max={3} step={0.05} value={render.bloomInt}
                onChange={e => setR('bloomInt', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
            </div>
          )}
        </Sec>
        </>)}
      </LabAdvancedPanel>

      {/* ── Viewport ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

        <div style={{ flex: 1, position: 'relative' }}>
          <ViewCanvas viewType={view1} shape={shape} modelUrl={modelUrl} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} instanceGeoUrl={instanceGeoUrl} instanceSize={instanceSize} pollution={cloudMode} cloud={cloud} data={data} playSpeed={animSpeed} speedRef={animSpeedRef} showLabels={showLabels} />
        </div>

        {/* LEGACY two-view split — commented out
        {view2 !== null && (
          <div style={{ flex: 1, position: 'relative', borderTop: '1px solid var(--lab-divider)' }}>
            <ViewCanvas viewType={view2} shape={shape} modelUrl={modelUrl} count={count} size={size} forcesRef={forcesRef} renderOptsRef={renderOptsRef} instanceGeoUrl={instanceGeoUrl} />
          </div>
        )}
        <LabViewSelector
          view1={view1} view2={view2}
          onView1={v => setView1(v)} onView2={v => setView2(v)}
          onAdd={() => setView2(view1 === 'effect' ? 'dynamic' : 'effect')}
          onRemove={() => setView2(null)}
        />
        */}

        <LabViewBar view={view} onChange={setView} options={{
          showLabels, onShowLabels: setShowLabels,
          speed: animSpeed, onSpeed: setAnimSpeed,
          // Smooth/transition doesn't apply to particles → no mode toggle.
        }} />

        {/* Reference — only offered when the loaded preset carries one. */}
        {reference && !showReference && <ReferenceButton onClick={() => setShowReference(true)} />}
        {reference && showReference && (
          <ReferencePanel reference={reference} onClose={() => setShowReference(false)} />
        )}
      </div>
    </div>
  )
}
