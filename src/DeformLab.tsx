import { useRef, useState, useEffect, useCallback, Suspense, useMemo, createContext, useContext } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment, Bounds, useBounds, Html } from '@react-three/drei'
import { useLoader } from '@react-three/fiber'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'
import {
  type SceneSave, type Shape, type ViewType, type DataField, type DataRow,
  type LabPresetHandle, type ColumnMeta,
  DATASET_EARTH, DATASET_WHALE, DATASET_GENERIC,
  ReferencePanel, ReferenceButton, referenceForData,
  DEFAULT_DATA, VIEW_LABELS, secBtnSt, priBtnSt, floatSelSt, floatIcoSt,
  Sec, SLabel, RowLabel,
  LabNavTitle, LabPresetRow, LabModelSection, LabDataPanel,
  LabAdvancedToggle, LabAdvancedPanel, LabViewSelector, LabViewBar,
  type LabView, type DynMode,
  serverFetch, bundledLabPresets,
} from './LabShared'
import { MODEL_PRESETS } from './models'

const SERVER = import.meta.env.VITE_SERVER ?? 'http://localhost:3001'

type DeformMode = 'STRETCH' | 'TWIST' | 'SLICE'
// | 'BEND' | 'TAPER' | 'TWIST_STRETCH' | 'INFLATE'
type Axis      = 'X' | 'Y' | 'Z'
type BindingMap = Partial<Record<'factor', DataField>>

interface BindingRange { outMin: number; outMax: number }

const texLabel = (f: string) => f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')

const MODE_INFO = {
  STRETCH: { label: 'Stretch', factorLabel: 'Amount',   factorMin: 0,    factorMax: 3,   factorStep: 0.05, hint: 'Elongates along axis, squishes perpendicular.' },
  TWIST:   { label: 'Twist',   factorLabel: 'Angle °',  factorMin: -720, factorMax: 720, factorStep: 5,    hint: 'Twists around the deform axis. Up to ±720°.' },
  SLICE:   { label: 'Slice',   factorLabel: 'Cut pos %', factorMin: 1,   factorMax: 99,  factorStep: 1,    hint: 'Cuts the mesh at a data-driven position along the axis. Bind "value" to drive each instance.' },
}

// ── Deformation "stress" effects ──────────────────────────────────────────────
// Material effects that grow with the deformation amount (morph influence, 0→1)
// so they read as the surface reacting to being deformed. Controlled from the
// Advanced panel and work on any geometry. Colour-based effects (tint, glow,
// cracks) share the single chosen `tintColor`.

const STRESS_PRESET_NAME = 'stretch - earth'   // compared case-insensitively; seeds earth defaults

const FX_TINT_STRENGTH = 0.85   // max colour blend at full deform
const FX_DISTORT_AMP   = 0.05   // max surface wobble (object-space)
const FX_DISTORT_FREQ  = 8.0    // spatial ripple frequency
const FX_DISTORT_SPEED = 2.5    // ripple animation speed
const FX_GLOW_MAX      = 1.6    // max emissive intensity
const FX_CRACK_FREQ    = 5.5    // crack network density

export interface StressFx {
  tint:         boolean
  tintColor:    string
  distort:      boolean
  glow:         boolean
  cracks:       boolean
  crackDensity: number   // spatial frequency of the crack network
  crackWidth:   number   // line thickness
  desaturate:   boolean
}

export const FX_OFF: StressFx = {
  tint: false, tintColor: '#d62828', distort: false, glow: false,
  cracks: false, crackDensity: FX_CRACK_FREQ, crackWidth: 0.08, desaturate: false,
}
// Crack look pinned to the "Stretch - earth" preset (applied on every load of it).
const FX_EARTH_CRACKS = { cracks: true, crackDensity: 16.0, crackWidth: 0.03 }
// Seeded when the legacy "Stretch - earth" preset is loaded without saved fx.
const FX_EARTH: StressFx = { ...FX_OFF, tint: true, distort: true, ...FX_EARTH_CRACKS }

// Datasets seeded by the earth / whale presets live in LabShared (they also
// populate the data-panel dropdown); the references stay lab-local.
const EARTH_DATA    = DATASET_EARTH.data
const EARTH_COLUMNS = DATASET_EARTH.columns
const WHALE_DATA    = DATASET_WHALE.data
const WHALE_COLUMNS = DATASET_WHALE.columns
const WHALE_PRESET_MATCH = 'whale'   // matched as a substring of the preset name

function fxAnyOn(fx?: StressFx | null): fx is StressFx {
  return !!fx && (fx.tint || fx.distort || fx.glow || fx.cracks || fx.desaturate)
}

const _fxColor = new THREE.Color()

type FxUniforms = {
  uTime:       { value: number }
  uAmp:        { value: number }
  uCrack:      { value: number }
  uCrackFreq:  { value: number }
  uCrackWidth: { value: number }
  uDesat:      { value: number }
  uCrackColor: { value: THREE.Color }
}
type FxMat = THREE.MeshStandardMaterial & {
  __fxU?:    FxUniforms
  __fxBase?: { color: THREE.Color; emissive: THREE.Color; emissiveIntensity: number }
}

// Give a cloned subtree its own material instances so per-clone effects don't
// leak across clones (three's clone(true) shares material references).
function ensureUniqueMaterials(root: THREE.Object3D) {
  root.traverse(n => {
    const m = n as THREE.Mesh
    if (!m.isMesh || !m.material) return
    m.material = Array.isArray(m.material)
      ? m.material.map(x => x.clone())
      : (m.material as THREE.Material).clone()
  })
}

// Inject the shader-based effects (vertex distortion + fragment cracks/desaturate)
// once per material, and cache the base look for the CPU-driven tint/glow. three
// includes onBeforeCompile.toString() in its program cache key, so distinct
// materials still compile their own programs.
function installFxShader(root: THREE.Object3D) {
  const f  = FX_DISTORT_FREQ.toFixed(1)
  root.traverse(n => {
    const m = n as THREE.Mesh
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    mats.forEach(mat => {
      const mm = mat as FxMat
      if (mm.__fxU) return
      const u: FxUniforms = {
        uTime: { value: 0 }, uAmp: { value: 0 }, uCrack: { value: 0 }, uDesat: { value: 0 },
        uCrackFreq: { value: FX_CRACK_FREQ }, uCrackWidth: { value: 0.08 },
        uCrackColor: { value: new THREE.Color('#d62828') },
      }
      mm.__fxU = u
      mm.__fxBase = {
        color:             mm.color ? mm.color.clone() : new THREE.Color(1, 1, 1),
        emissive:          mm.emissive ? mm.emissive.clone() : new THREE.Color(0, 0, 0),
        emissiveIntensity: mm.emissiveIntensity ?? 1,
      }
      mm.onBeforeCompile = shader => {
        shader.uniforms.uTime       = u.uTime
        shader.uniforms.uAmp        = u.uAmp
        shader.uniforms.uCrack      = u.uCrack
        shader.uniforms.uCrackFreq  = u.uCrackFreq
        shader.uniforms.uCrackWidth = u.uCrackWidth
        shader.uniforms.uDesat      = u.uDesat
        shader.uniforms.uCrackColor = u.uCrackColor

        // Vertex: animated displacement along the normal + object-space position varying.
        shader.vertexShader = 'uniform float uTime;\nuniform float uAmp;\nvarying vec3 vFxPos;\n' + shader.vertexShader
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vFxPos = position;
          float fxD = sin(position.x * ${f} + uTime * ${FX_DISTORT_SPEED.toFixed(1)})
                    * cos(position.y * ${f} + uTime * ${(FX_DISTORT_SPEED * 0.8).toFixed(1)})
                    * sin(position.z * ${f} + uTime * ${(FX_DISTORT_SPEED * 0.9).toFixed(1)});
          transformed += normalize(normal) * fxD * uAmp;`
        )

        // Fragment: desaturate the diffuse, then add glowing cracks to the emissive.
        shader.fragmentShader = 'uniform float uCrack;\nuniform float uCrackFreq;\nuniform float uCrackWidth;\nuniform float uDesat;\nuniform vec3 uCrackColor;\nvarying vec3 vFxPos;\n' + shader.fragmentShader
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          {
            float fxLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(fxLum), uDesat);
          }`
        )
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            // Low-frequency domain warp (in object space, so it scales with the
            // density slider) — bends the field and kills the axis-aligned lattice.
            vec3 fxW = vec3(
              sin(vFxPos.y * 2.7 + 1.7) + sin(vFxPos.z * 3.3 + 4.2),
              sin(vFxPos.z * 2.9 + 2.3) + sin(vFxPos.x * 3.1 + 0.7),
              sin(vFxPos.x * 3.2 + 3.1) + sin(vFxPos.y * 2.8 + 5.3)
            );
            vec3 fxP = (vFxPos + fxW * 0.12) * uCrackFreq;
            // Skewed, non-orthogonal directions at irrational-ish ratios so the
            // waves never line up into a repeating symmetric pattern.
            float fxField = sin(dot(fxP, vec3( 1.00,  0.37, -0.62))         + 1.3)
                          + sin(dot(fxP, vec3(-0.48,  0.93,  0.21)) * 0.87  + 2.9)
                          + sin(dot(fxP, vec3( 0.29, -0.55,  1.07)) * 1.19  + 5.1)
                          + sin(dot(fxP, vec3( 1.63, -1.11,  0.87)) * 0.53  + 0.4) * 0.6;
            float fxLine = 1.0 - smoothstep(0.0, uCrackWidth * (1.0 + 2.0 * uCrack), abs(fxField));
            totalEmissiveRadiance += uCrackColor * fxLine * uCrack * 2.0;
          }`
        )
      }
      mm.needsUpdate = true
    })
  })
}

// Clone materials + install the effect shader — one-time setup per subtree.
function prepareFx(root: THREE.Object3D) {
  ensureUniqueMaterials(root)
  installFxShader(root)
}

// Per-frame effect update. `t` is the deform amount (0→1); `time` the clock. Tint
// and glow are applied on the CPU (so they compose with textures); distortion,
// cracks and desaturate are driven through the shader uniforms.
function applyFx(root: THREE.Object3D, fx: StressFx, t: number, time: number) {
  const amt  = Math.min(1, Math.max(0, t))
  const tint = _fxColor.set(fx.tintColor)
  root.traverse(n => {
    const m = n as THREE.Mesh
    if (!m.isMesh || !m.material) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    mats.forEach(mat => {
      const mm   = mat as FxMat
      const base = mm.__fxBase
      if (base && mm.color) {
        if (fx.tint) mm.color.copy(base.color).lerp(tint, amt * FX_TINT_STRENGTH)
        else         mm.color.copy(base.color)
      }
      if (base && mm.emissive) {
        if (fx.glow) { mm.emissive.copy(tint); mm.emissiveIntensity = amt * FX_GLOW_MAX }
        else         { mm.emissive.copy(base.emissive); mm.emissiveIntensity = base.emissiveIntensity }
      }
      const u = mm.__fxU
      if (u) {
        u.uTime.value       = time
        u.uAmp.value        = fx.distort ? amt * FX_DISTORT_AMP : 0
        u.uCrack.value      = fx.cracks ? amt : 0
        u.uCrackFreq.value  = fx.crackDensity
        u.uCrackWidth.value = fx.crackWidth
        u.uDesat.value      = fx.desaturate ? amt : 0
        u.uCrackColor.value.copy(tint)
      }
    })
  })
}

const SPACING       = 3.0
const SLICE_GAP     = 0.15   // must match slice.py GAP constant
const ANIM_PAUSE    = 0.5    // s — hold collapsed before exploding
const ANIM_EXPLODE  = 1.5    // s — duration of explode animation
const ANIM_HOLD     = 2.5    // s — hold exploded with labels before reset
const ANIM_CYCLE    = ANIM_PAUSE + ANIM_EXPLODE + ANIM_HOLD

// ── Preset storage (keyed per-lab so each lab keeps its own saves) ─────────────

const DEFORM_PRESETS_KEY = 'phys_tool_deform_presets'

function loadDeformPresets(): SceneSave[] {
  try { return JSON.parse(localStorage.getItem(DEFORM_PRESETS_KEY) ?? '[]') } catch { return [] }
}

function persistDeformPresets(saves: SceneSave[]) {
  localStorage.setItem(DEFORM_PRESETS_KEY, JSON.stringify(saves))
}

// ── Camera fit ────────────────────────────────────────────────────────────────
// The views remount on every bake (keyed by resultUrl), which would re-frame the
// camera each time. FitContext carries the current model's identity + a persistent
// ref, so FitCamera only fits when a *new* model/shape is loaded — re-simulations
// keep the camera exactly where the user left it.
const FitContext = createContext<{ key: string; ref: React.MutableRefObject<string> } | null>(null)

function FitCamera() {
  const api = useBounds()
  const ctx = useContext(FitContext)
  useEffect(() => {
    if (ctx) {
      if (ctx.ref.current === ctx.key) return   // already framed for this model
      ctx.ref.current = ctx.key
    }
    api.refresh().fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])
  return null
}

// ── Effect view ───────────────────────────────────────────────────────────────

function EffectView({ url, speed, fx, data, playData }: {
  url: string; speed: number; fx?: StressFx | null
  data?: DataRow[]; playData?: boolean
}) {
  const gltf   = useLoader(GLTFLoader, url)
  const active = fxAnyOn(fx)
  const scene = useMemo(() => {
    const s = gltf.scene.clone(true)
    if (active) prepareFx(s)
    return s
  }, [gltf, active])

  // Data mode: as the effect plays, label the data point whose (normalised) value
  // matches the current stretch, so the label steps through the categories.
  const dataMode = !!playData && !!data && data.length > 0
  const tValues = useMemo(() => {
    if (!data || !data.length) return []
    const vs = data.map(r => r.value)
    const mn = Math.min(...vs), mx = Math.max(...vs)
    return data.map(r => (r.value - mn) / Math.max(mx - mn, 0.001))
  }, [data])

  const [activeIdx, setActiveIdx] = useState(0)
  const activeIdxRef = useRef(0)
  const labelRef     = useRef<THREE.Group>(null)
  const boxRef       = useRef(new THREE.Box3())
  const ctrRef       = useRef(new THREE.Vector3())

  useFrame(({ clock }) => {
    const el = clock.getElapsedTime()
    const t  = (Math.sin(el * speed) + 1) / 2
    scene.traverse(n => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.morphTargetInfluences?.length) m.morphTargetInfluences[0] = t
    })
    if (fxAnyOn(fx)) applyFx(scene, fx, t, el)
    if (dataMode) {
      // Nearest data point to the current stretch level.
      let best = 0, bestD = Infinity
      for (let i = 0; i < tValues.length; i++) {
        const d = Math.abs(tValues[i] - t)
        if (d < bestD) { bestD = d; best = i }
      }
      if (best !== activeIdxRef.current) { activeIdxRef.current = best; setActiveIdx(best) }
      // Keep the label pinned just below the (stretching) object. `precise` walks
      // the morphed vertices so it tracks the real bottom as the shape stretches.
      if (labelRef.current) {
        boxRef.current.setFromObject(scene, true)
        const c = boxRef.current.getCenter(ctrRef.current)
        labelRef.current.position.set(c.x, boxRef.current.min.y - 0.28, c.z)
      }
    }
  })

  const row = dataMode && data ? data[activeIdx] : null

  return (
    <Bounds clip margin={1.2}>
      <FitCamera />
      <primitive object={scene} />
      {row && (
        <group ref={labelRef}>
          <Html center style={{ pointerEvents: 'none', textAlign: 'center' }}>
            <div style={{
              fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap',
              background: 'rgba(0,0,0,0.52)', padding: '4px 14px', borderRadius: 4,
            }}>
              <div style={{ fontSize: 16, color: '#e0e0f0', fontWeight: 600, letterSpacing: 0.4 }}>{row.category}</div>
              <div style={{ fontSize: 14, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{row.value}</div>
            </div>
          </Html>
        </group>
      )}
    </Bounds>
  )
}

// ── Static view ───────────────────────────────────────────────────────────────

function StaticView({ url, data, range, fx }: {
  url: string; data: DataRow[]; range: BindingRange; fx?: StressFx | null
}) {
  const gltf    = useLoader(GLTFLoader, url)
  const dataMin = Math.min(...data.map(r => r.value))
  const dataMax = Math.max(...data.map(r => r.value))

  // Per-instance stretch amount (morph influence). The static view compares data
  // categories, so each instance is always deformed by its own (normalised) value;
  // an explicit `value` binding just lets the user remap the output range. This
  // drives both the mesh shape and the stress tint / distortion amplitude.
  const ts = useMemo(() => data.map(row => {
    const norm = (row.value - dataMin) / Math.max(dataMax - dataMin, 0.001)
    return Math.max(0, Math.min(1, range.outMin + norm * (range.outMax - range.outMin)))
  }), [data, range, dataMin, dataMax])

  const active = fxAnyOn(fx)
  const clones = useMemo(() => data.map((_row, i) => {
    const clone = gltf.scene.clone(true)
    const t = ts[i]
    clone.traverse(n => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.morphTargetInfluences?.length) m.morphTargetInfluences[0] = t
    })
    if (active) prepareFx(clone)
    return clone
  }), [gltf, data, ts, active])

  // Animate each instance's effects (intensity ∝ its own stretch amount).
  useFrame(({ clock }) => {
    if (!fxAnyOn(fx)) return
    const el = clock.getElapsedTime()
    clones.forEach((clone, i) => applyFx(clone, fx, ts[i], el))
  })

  // Per-clone bounding boxes — used for spacing and label Y position.
  // `precise` (2nd arg) walks actual vertices via getVertexPosition, which applies
  // the morph influence, so a stretched (X-squished) instance reports its true
  // narrower width — essential for even edge-to-edge spacing below.
  const boxes = useMemo(
    () => clones.map(c => new THREE.Box3().setFromObject(c, true)),
    [clones]
  )

  // Lay the objects out left→right using each one's ACTUAL width, so the gap
  // between neighbours is constant even though stretched objects are narrower.
  // Result is centred around x=0.
  const positions = useMemo(() => {
    const widths = boxes.map(b => b.max.x - b.min.x)
    const avgW   = widths.reduce((a, c) => a + c, 0) / Math.max(widths.length, 1)
    const gap    = avgW * 0.12
    const xs: number[] = []
    let cursor = 0                       // world-x where the next object's left edge goes
    boxes.forEach(b => {
      xs.push(cursor - b.min.x)          // group x so this object's left edge sits at cursor
      cursor += (b.max.x - b.min.x) + gap
    })
    const span = cursor - gap            // world-x of the last object's right edge (left edge started at 0)
    return xs.map(x => x - span / 2)     // centre the whole row on x=0
  }, [boxes])

  return (
    <Bounds clip margin={1.2}>
      <FitCamera />
      {clones.map((clone, i) => {
        const box = boxes[i]
        const cx  = (box.min.x + box.max.x) / 2   // visual centre X of this clone
        const ly  = box.min.y - 0.12
        return (
          <group key={i} position={[positions[i], 0, 0]}>
            <primitive object={clone} />
            <Html center position={[cx, ly, 0]}
              style={{ pointerEvents: 'none', textAlign: 'center' }}>
              <div style={{
                fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap',
                background: 'rgba(0,0,0,0.52)', padding: '2px 8px', borderRadius: 4,
              }}>
                <div style={{ fontSize: 14, color: '#e0e0f0', fontWeight: 600, letterSpacing: 0.4 }}>{data[i].category}</div>
                <div style={{ fontSize: 13, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{data[i].value}</div>
              </div>
            </Html>
          </group>
        )
      })}
    </Bounds>
  )
}

// ── Slice view ────────────────────────────────────────────────────────────────
// The baked GLB contains N mesh objects already positioned by Blender.
// In static mode we sort them along the cut axis and overlay data labels.

function SliceView({ url, data, axis, showLabels }: {
  url: string; data: DataRow[]; axis: Axis; showLabels: boolean
}) {
  const gltf  = useLoader(GLTFLoader, url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf])

  // Resolve which Three.js component corresponds to the cut axis.
  // UI Y → Blender Z → Three.js Y (GLTF Y-up); X and Z map directly.
  const axisComp: 'x' | 'y' | 'z' = axis === 'X' ? 'x' : axis === 'Z' ? 'z' : 'y'
  const axisVal = (v: THREE.Vector3) => axisComp === 'x' ? v.x : axisComp === 'y' ? v.y : v.z

  // One entry per segment object exported by Blender.
  // Filter out non-geometry nodes (cameras, lights) that some GLB exporters include.
  // Sort ascending along the cut axis so index 0 = lowest boundary = data[0].
  const segments = useMemo(() => {
    // If Blender wrapped everything in one root group, descend one level.
    let candidates = [...scene.children]
    if (candidates.length === 1 && candidates[0].children.length > 1)
      candidates = [...candidates[0].children]

    return candidates
      .map(obj => {
        const box    = new THREE.Box3().setFromObject(obj)
        const center = box.getCenter(new THREE.Vector3())
        return { obj, center, box }
      })
      .filter(s => !s.box.isEmpty())          // drop cameras / lights
      // Blender Y → Three.js −Z, so Z-axis cuts are inverted; flip sort for Z only.
      .sort((a, b) => {
        const d = axisVal(a.center) - axisVal(b.center)
        return axis === 'Z' ? -d : d
      })
  }, [scene, axisComp]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Bounds clip margin={1.4}>
      <FitCamera />
      <primitive object={scene} />
      {showLabels && segments.map((seg, i) => {
        const row = data[i]
        if (!row) return null
        // Y/Z cuts: segments stacked along the cut axis → label to the right of each piece.
        // X cuts: segments arranged left-to-right → label centred below each piece.
        const lx = axis === 'X' ? seg.center.x           : seg.box.max.x + 0.12
        const ly = axis === 'X' ? seg.box.min.y - 0.14   : seg.center.y
        const lz = seg.center.z
        return (
          <Html key={i} center
            position={[lx, ly, lz]}
            style={{ pointerEvents: 'none', textAlign: axis === 'X' ? 'center' : 'left' }}
          >
            <div style={{
              fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap',
              background: 'rgba(0,0,0,0.52)', padding: '2px 8px', borderRadius: 4,
            }}>
              <div style={{ fontSize: 14, color: '#e0e0f0', fontWeight: 600, letterSpacing: 0.4 }}>{row.category}</div>
              <div style={{ fontSize: 13, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{row.value.toLocaleString()}</div>
            </div>
          </Html>
        )
      })}
    </Bounds>
  )
}

// ── Dynamic slice view ────────────────────────────────────────────────────────
// Segments start collapsed (all at origin) then animate to their exploded
// positions. Labels fade in once the pieces are fully spread apart, then the
// whole cycle repeats automatically.
//
// The baked GLB stores each segment with obj.position = pure gap-offset vector
// (geometry lives at world origin). Animating from (0,0,0) → obj.position gives
// the collapse-to-explode effect without any extra computation.

function DynamicSliceView({ url, data, axis, speed = 1, showLabels = true }: {
  url: string; data: DataRow[]; axis: Axis; speed?: number; showLabels?: boolean
}) {
  const gltf  = useLoader(GLTFLoader, url)
  const scene = useMemo(() => gltf.scene.clone(true), [gltf])

  const axisComp: 'x' | 'y' | 'z' = axis === 'X' ? 'x' : axis === 'Y' ? 'y' : 'z'
  const axisVal = (v: THREE.Vector3) => axisComp === 'x' ? v.x : axisComp === 'y' ? v.y : v.z

  const segments = useMemo(() => {
    let candidates = [...scene.children]
    if (candidates.length === 1 && candidates[0].children.length > 1)
      candidates = [...candidates[0].children]
    return candidates
      .map(obj => {
        const box    = new THREE.Box3().setFromObject(obj)
        const center = box.getCenter(new THREE.Vector3())
        return { obj, center, box }
      })
      .filter(s => !s.box.isEmpty())
      .sort((a, b) => {
        const d = axisVal(a.center) - axisVal(b.center)
        return axis === 'Z' ? -d : d
      })
  }, [scene, axisComp]) // eslint-disable-line react-hooks/exhaustive-deps

  // Exploded positions as loaded from the GLB (= the gap-offset vectors).
  const explodedPos = useMemo(
    () => segments.map(s => s.obj.position.clone()),
    [segments]
  )

  // ── Verify SLICE_GAP matches runtime positions ────────────────────────────
  // (If the user changes GAP in slice.py they'd re-bake; this is only for safety.)
  void SLICE_GAP

  const [labelsOn, setLabelsOn] = useState(false)
  const labelsRef = useRef(false)
  const tAcc      = useRef(0)   // accumulated so speed changes don't jump the phase

  useFrame((_, delta) => {
    tAcc.current += delta * speed
    const t    = tAcc.current % ANIM_CYCLE
    const raw  = t <= ANIM_PAUSE              ? 0
               : t <= ANIM_PAUSE + ANIM_EXPLODE ? (t - ANIM_PAUSE) / ANIM_EXPLODE
               : 1
    const eased = 1 - Math.pow(1 - raw, 3)   // ease-out cubic
    const hold  = t >= ANIM_PAUSE + ANIM_EXPLODE

    if (hold !== labelsRef.current) {
      labelsRef.current = hold
      setLabelsOn(hold)
    }

    // Lerp each segment from origin (collapsed) to its exploded position.
    segments.forEach((seg, i) => {
      const e = explodedPos[i]
      seg.obj.position.set(e.x * eased, e.y * eased, e.z * eased)
    })
  })

  return (
    <Bounds margin={1.4}>
      <FitCamera />
      <primitive object={scene} />
      {showLabels && segments.map((seg, i) => {
        const row = data[i]
        if (!row) return null
        const lx = axis === 'X' ? seg.center.x         : seg.box.max.x + 0.12
        const ly = axis === 'X' ? seg.box.min.y - 0.14 : seg.center.y
        return (
          <Html key={i} center
            position={[lx, ly, seg.center.z]}
            style={{ pointerEvents: 'none', textAlign: axis === 'X' ? 'center' : 'left' }}
          >
            <div style={{
              fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap',
              background: 'rgba(0,0,0,0.52)', padding: '2px 8px', borderRadius: 4,
              opacity: labelsOn ? 1 : 0,
              transition: 'opacity 0.4s ease',
            }}>
              <div style={{ fontSize: 14, color: '#e0e0f0', fontWeight: 600, letterSpacing: 0.4 }}>{row.category}</div>
              <div style={{ fontSize: 13, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{row.value.toLocaleString()}</div>
            </div>
          </Html>
        )
      })}
    </Bounds>
  )
}

// ── Dynamic deform view (TWIST / STRETCH) ────────────────────────────────────
// Cycles through each data category, morphing the object to that category's
// deformation level, holding with a label, then transitioning to the next.

const DYNA_HOLD  = 1.2   // seconds to hold each category (label visible)
const DYNA_TRANS = 0.7   // seconds to animate between categories
const DYNA_SLOT  = DYNA_HOLD + DYNA_TRANS

function DynamicDeformView({ url, data, fx, speed = 1, showLabels = true }: {
  url: string; data: DataRow[]; fx?: StressFx | null; speed?: number; showLabels?: boolean
}) {
  const gltf   = useLoader(GLTFLoader, url)
  const active = fxAnyOn(fx)
  const scene = useMemo(() => {
    const s = gltf.scene.clone(true)
    if (active) prepareFx(s)
    return s
  }, [gltf, active])

  const meshes = useMemo(() => {
    const r: THREE.Mesh[] = []
    scene.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh && m.morphTargetInfluences?.length) r.push(m) })
    return r
  }, [scene])

  const dataMin = Math.min(...data.map(r => r.value))
  const dataMax = Math.max(...data.map(r => r.value))
  const tValues = useMemo(() =>
    data.map(row => (row.value - dataMin) / Math.max(dataMax - dataMin, 0.001)),
  [data, dataMin, dataMax])

  const N = data.length

  const [activeIdx, setActiveIdx] = useState(0)
  const [showLabel, setShowLabel] = useState(true)
  const activeIdxRef = useRef(0)
  const showLabelRef = useRef(true)
  // Accumulated (speed-scaled) time; starts inside slot 0's hold phase so the
  // first thing seen is a held category, and speed changes never jump the phase.
  const tAcc = useRef(DYNA_TRANS)

  // Center of the Basis (undeformed) bounding box
  const labelCenter = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const c = new THREE.Vector3()
    box.getCenter(c)
    return c
  }, [scene])

  useFrame(({ clock }, delta) => {
    tAcc.current += delta * speed
    const t      = tAcc.current
    const slotRaw = Math.floor(t / DYNA_SLOT)
    const slotIdx = slotRaw % N
    const phase   = t % DYNA_SLOT
    const inHold  = phase >= DYNA_TRANS

    if (slotIdx !== activeIdxRef.current) { activeIdxRef.current = slotIdx; setActiveIdx(slotIdx) }
    if (inHold  !== showLabelRef.current) { showLabelRef.current = inHold;  setShowLabel(inHold)  }

    let morphVal: number
    if (inHold) {
      morphVal = tValues[slotIdx]
    } else {
      const prevIdx = (slotIdx - 1 + N) % N
      const eased   = 1 - Math.pow(1 - phase / DYNA_TRANS, 3)
      morphVal = tValues[prevIdx] + (tValues[slotIdx] - tValues[prevIdx]) * eased
    }

    meshes.forEach(m => { if (m.morphTargetInfluences) m.morphTargetInfluences[0] = morphVal })
    if (fxAnyOn(fx)) applyFx(scene, fx, morphVal, clock.getElapsedTime())
  })

  const row = data[activeIdx] ?? data[0]

  return (
    <Bounds margin={1.6}>
      <FitCamera />
      <primitive object={scene} />
      {showLabels && (
        <Html center position={[labelCenter.x, labelCenter.y, labelCenter.z]} style={{ pointerEvents: 'none' }}>
          <div style={{
            fontFamily: 'system-ui, sans-serif', whiteSpace: 'nowrap', textAlign: 'center',
            background: 'rgba(0,0,0,0.52)', padding: '4px 14px', borderRadius: 4,
            opacity: showLabel ? 1 : 0, transition: 'opacity 0.35s ease',
          }}>
            <div style={{ fontSize: 16, color: '#e0e0f0', fontWeight: 600, letterSpacing: 0.4 }}>{row.category}</div>
            <div style={{ fontSize: 14, color: '#a090e8', fontVariantNumeric: 'tabular-nums' }}>{row.value}</div>
          </div>
        </Html>
      )}
    </Bounds>
  )
}

// Center + scale an object to max-dimension = `target`, matching what the Blender
// bake does to every result (deform.py). This makes the raw preview / baking scene
// share the exact size & placement of the simulated result.
function normalizeToBake(obj: THREE.Object3D, target = 2) {
  obj.updateWorldMatrix(true, true)
  const box  = new THREE.Box3().setFromObject(obj)
  const c    = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const sc   = target / Math.max(size.x, size.y, size.z, 1e-4)
  obj.scale.setScalar(sc)
  obj.position.set(-c.x * sc, -c.y * sc, -c.z * sc)
  obj.updateMatrixWorld(true)
}

// Raw model preview (shown before a bake exists), normalised to match the result.
function ModelPreview({ url }: { url: string }) {
  const gltf  = useLoader(GLTFLoader, url)
  const scene = useMemo(() => { const s = gltf.scene.clone(true); normalizeToBake(s); return s }, [gltf])
  return (
    <Bounds clip margin={1.3}>
      <FitCamera />
      <primitive object={scene} />
    </Bounds>
  )
}

// ── "Baking" animation ────────────────────────────────────────────────────────
// While the Blender bake runs the model shows as a dense point cloud with only a
// slight jitter (so the shape stays clear), with yellow particles dancing around
// it — orbiting on tilted planes while pulsing in/out and bobbing.
const BAKE_COLOR      = new THREE.Color('#5ad6ff')   // point cloud
const BAKE_DANCE      = new THREE.Color('#ffd23a')   // cluster particles
const BAKE_POINTS     = 9000
const BAKE_CLUSTERS = 35    // clusters drifting near the surface
const BAKE_CLUST_SZ = 22    // particles per cluster (dense knots)
const BAKE_SPRING   = 3.5   // pull toward the current goal (smaller = slower/smoother)
const BAKE_DAMP     = 4.0   // velocity damping (larger = calmer, less overshoot)
const BAKE_STANDOFF = 0.12  // how far off the surface (× radius) the goals sit

// Round, soft, per-point-alpha points (used for both the cloud and the smoke).
const BAKE_PT_VERT = `
  attribute float aAlpha;
  uniform float uSize;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (350.0 / max(-mv.z, 0.001));
  }
`
const BAKE_PT_FRAG = `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, r) * vAlpha);
  }
`

function BakingScene({ url }: { url: string }) {
  const gltf = useLoader(GLTFLoader, url)

  // Dense, messy point cloud built from the (normalised) model's vertices, plus
  // a per-point random direction so the cloud shimmers chaotically — not as a
  // clean surface. Normalising here matches the result's size & placement.
  const { base, dir, spd, phase, count, cx, cy, cz, radius, height } = useMemo(() => {
    const s = gltf.scene.clone(true)
    normalizeToBake(s)
    const box  = new THREE.Box3().setFromObject(s)
    const sph  = box.getBoundingSphere(new THREE.Sphere())
    const size = box.getSize(new THREE.Vector3())
    const c    = sph.center, rad = sph.radius || 1
    const meshes: THREE.Mesh[] = []
    s.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
    const totalV = meshes.reduce((sum, m) => sum + m.geometry.attributes.position.count, 0)
    const stride = Math.max(1, Math.floor(totalV / BAKE_POINTS))
    const verts: number[] = []
    const v = new THREE.Vector3()
    meshes.forEach(m => {
      const pos = m.geometry.attributes.position
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
        verts.push(v.x, v.y, v.z)
      }
    })
    const n = verts.length / 3
    const b = new Float32Array(verts), dr = new Float32Array(n * 3)
    const sp = new Float32Array(n), ph = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      // Random unit direction (messy, not radial).
      let dx = Math.random()*2-1, dy = Math.random()*2-1, dz = Math.random()*2-1
      const l = Math.hypot(dx, dy, dz) || 1; dx/=l; dy/=l; dz/=l
      dr[i*3] = dx; dr[i*3+1] = dy; dr[i*3+2] = dz
      sp[i] = 0.7 + Math.random() * 1.8
      ph[i] = Math.random() * Math.PI * 2
      // Small static scatter — keeps points near the surface so the shape stays clear.
      const j = Math.random() * rad * 0.03
      b[i*3] += dx*j; b[i*3+1] += dy*j; b[i*3+2] += dz*j
    }
    return { base: b, dir: dr, spd: sp, phase: ph, count: n, cx: c.x, cy: c.y, cz: c.z, radius: rad, height: size.y || 1 }
  }, [gltf])

  const ptGeo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3))
    g.setAttribute('aAlpha',   new THREE.BufferAttribute(new Float32Array(count), 1))
    return g
  }, [base, count])
  const ptMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uSize: { value: radius * 0.05 }, uColor: { value: BAKE_COLOR } },
    vertexShader: BAKE_PT_VERT, fragmentShader: BAKE_PT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }), [radius])

  // Clusters drift smoothly NEAR the surface: each has a goal a little off the
  // surface (a vertex pushed out along its radial normal) and eases toward it with
  // spring + damping. On arrival it picks a nearby goal, so it glides organically
  // over the object. Particles ride along as a dense knot.
  const clusters = useMemo(() => {
    const C = BAKE_CLUSTERS, standoff = radius * BAKE_STANDOFF
    const pos = new Float32Array(C*3), vel = new Float32Array(C*3), goal = new Float32Array(C*3)
    // Goal = a surface vertex pushed outward from the centre by `standoff`.
    const goalFrom = (arr: Float32Array, o: number, vi: number) => {
      const vx = base[vi]-cx, vy = base[vi+1]-cy, vz = base[vi+2]-cz
      const vl = Math.hypot(vx, vy, vz) || 1
      arr[o] = base[vi] + vx/vl*standoff; arr[o+1] = base[vi+1] + vy/vl*standoff; arr[o+2] = base[vi+2] + vz/vl*standoff
    }
    for (let c = 0; c < C; c++) {
      goalFrom(pos,  c*3, Math.floor(Math.random()*count)*3)
      goalFrom(goal, c*3, Math.floor(Math.random()*count)*3)
    }
    // Per-particle tight local offset (so a cluster reads as a dense knot) + phase.
    const M = C * BAKE_CLUST_SZ
    const off = new Float32Array(M*3), jph = new Float32Array(M)
    for (let i = 0; i < M; i++) {
      let ox = Math.random()*2-1, oy = Math.random()*2-1, oz = Math.random()*2-1
      const ol = Math.hypot(ox, oy, oz) || 1
      const m = (Math.random() * radius * 0.035) / ol
      off[i*3] = ox*m; off[i*3+1] = oy*m; off[i*3+2] = oz*m
      jph[i] = Math.random() * Math.PI * 2
    }
    return { pos, vel, goal, off, jph, M }
  }, [base, count, radius, cx, cy, cz])
  const clustGeo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BAKE_CLUSTERS * BAKE_CLUST_SZ * 3), 3))
    g.setAttribute('aAlpha',   new THREE.BufferAttribute(new Float32Array(BAKE_CLUSTERS * BAKE_CLUST_SZ), 1))
    return g
  }, [])
  const clustMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uSize: { value: radius * 0.06 }, uColor: { value: BAKE_DANCE } },
    vertexShader: BAKE_PT_VERT, fragmentShader: BAKE_PT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }), [radius])

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime()

    // Point cloud: only a very slight jitter, so the shape reads clearly.
    const pp = (ptGeo.attributes.position as THREE.BufferAttribute).array as Float32Array
    const pa = (ptGeo.attributes.aAlpha   as THREE.BufferAttribute).array as Float32Array
    const amp = radius * 0.015
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, ph = phase[i], spi = spd[i]
      const disp = Math.sin(t * spi + ph) * amp
      pp[i3]   = base[i3]   + dir[i3]   * disp
      pp[i3+1] = base[i3+1] + dir[i3+1] * disp
      pp[i3+2] = base[i3+2] + dir[i3+2] * disp
      pa[i] = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2 + ph * 5.0))
    }
    ;(ptGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(ptGeo.attributes.aAlpha   as THREE.BufferAttribute).needsUpdate = true

    // Clusters ease smoothly toward a goal near the surface (spring + damping);
    // on arrival pick a nearby goal so the drift stays organic and continuous.
    const { pos, vel, goal } = clusters
    const dt = Math.min(delta, 0.05)
    const damp = 1 - Math.min(BAKE_DAMP * dt, 0.5)
    const standoff = radius * BAKE_STANDOFF, reach = radius * 0.06, minD = radius * 0.12
    for (let c = 0; c < BAKE_CLUSTERS; c++) {
      const c3 = c * 3
      vel[c3]   = (vel[c3]   + (goal[c3]  -pos[c3])  *BAKE_SPRING*dt) * damp
      vel[c3+1] = (vel[c3+1] + (goal[c3+1]-pos[c3+1])*BAKE_SPRING*dt) * damp
      vel[c3+2] = (vel[c3+2] + (goal[c3+2]-pos[c3+2])*BAKE_SPRING*dt) * damp
      pos[c3] += vel[c3]*dt; pos[c3+1] += vel[c3+1]*dt; pos[c3+2] += vel[c3+2]*dt
      const gx = goal[c3]-pos[c3], gy = goal[c3+1]-pos[c3+1], gz = goal[c3+2]-pos[c3+2]
      if (Math.hypot(gx, gy, gz) < reach) {
        // Nearest of a few random vertices → a short, smooth step along the surface.
        let bi = Math.floor(Math.random()*count)*3, bd = Infinity
        for (let k = 0; k < 6; k++) {
          const b = Math.floor(Math.random()*count)*3
          const ddx = base[b]-pos[c3], ddy = base[b+1]-pos[c3+1], ddz = base[b+2]-pos[c3+2]
          const dd = ddx*ddx + ddy*ddy + ddz*ddz
          if (dd > minD*minD && dd < bd) { bd = dd; bi = b }
        }
        const vx = base[bi]-cx, vy = base[bi+1]-cy, vz = base[bi+2]-cz
        const vl = Math.hypot(vx, vy, vz) || 1
        goal[c3] = base[bi] + vx/vl*standoff; goal[c3+1] = base[bi+1] + vy/vl*standoff; goal[c3+2] = base[bi+2] + vz/vl*standoff
      }
    }
    const cp = (clustGeo.attributes.position as THREE.BufferAttribute).array as Float32Array
    const cAlpha = (clustGeo.attributes.aAlpha as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < clusters.M; i++) {
      const c3 = Math.floor(i / BAKE_CLUST_SZ) * 3, i3 = i * 3
      const breathe = 1 + 0.15 * Math.sin(t * 1.2 + clusters.jph[i])
      cp[i3]   = pos[c3]   + clusters.off[i3]   * breathe
      cp[i3+1] = pos[c3+1] + clusters.off[i3+1] * breathe
      cp[i3+2] = pos[c3+2] + clusters.off[i3+2] * breathe
      cAlpha[i] = 0.6 + 0.4 * Math.sin(t * 2.0 + clusters.jph[i] * 4.0)
    }
    ;(clustGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(clustGeo.attributes.aAlpha   as THREE.BufferAttribute).needsUpdate = true
  })

  return (
    <Bounds clip margin={1.3}>
      <FitCamera />
      {/* Invisible sphere so the effect frames consistently if it's the first thing shown. */}
      <mesh position={[cx, cy, cz]} visible={false}><sphereGeometry args={[radius * 1.4, 8, 8]} /></mesh>
      <points geometry={ptGeo} material={ptMat} />
      <points geometry={clustGeo} material={clustMat} />
    </Bounds>
  )
}

// ── Per-view canvas ───────────────────────────────────────────────────────────

function ViewCanvas({ viewType, resultUrl, modelUrl, baking, fitKey, animSpeed, data, bindingRange, deformMode, axis, fx, playData, showLabels = true }: {
  viewType: ViewType; resultUrl: string | null; modelUrl: string | null; baking: boolean; fitKey: string; animSpeed: number
  data: DataRow[]; bindingRange: BindingRange; deformMode: DeformMode; axis: Axis
  fx?: StressFx | null; playData?: boolean; showLabels?: boolean
}) {
  const fittedRef = useRef('')
  const fitCtx = useMemo(() => ({ key: fitKey, ref: fittedRef }), [fitKey])
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas camera={{ fov: 35 }} gl={{ antialias: true }} style={{ background: '#000000' }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} />
        <Environment preset="city" />
        <OrbitControls makeDefault />
        <FitContext.Provider value={fitCtx}>
        {resultUrl ? (
          <Suspense fallback={null}>
            {deformMode === 'SLICE'
              ? viewType === 'dynamic'
                ? <DynamicSliceView key={resultUrl} url={resultUrl!} data={data} axis={axis} speed={animSpeed} showLabels={showLabels} />
                : <SliceView key={resultUrl} url={resultUrl!} data={data} axis={axis} showLabels={viewType === 'static'} />
              : viewType === 'static'
                ? <StaticView key={resultUrl} url={resultUrl!} data={data} range={bindingRange} fx={fx} />
                : viewType === 'dynamic'
                  ? <DynamicDeformView key={resultUrl} url={resultUrl!} data={data} fx={fx} speed={animSpeed} showLabels={showLabels} />
                  : <EffectView key={resultUrl} url={resultUrl!} speed={animSpeed} fx={fx} data={data} playData={showLabels} />}
          </Suspense>
        ) : baking && modelUrl ? (
          // Bake in progress — construction animation on the loaded model.
          <Suspense fallback={null}>
            <BakingScene key={modelUrl} url={modelUrl} />
          </Suspense>
        ) : modelUrl ? (
          // No bake yet — show the raw model so it's visible before Run.
          <Suspense fallback={null}>
            <ModelPreview key={modelUrl} url={modelUrl} />
          </Suspense>
        ) : null}
        </FitContext.Provider>
      </Canvas>
    </div>
  )
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '7px 0', fontSize: 10, borderRadius: 6, cursor: 'pointer',
      background: active ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
      color:      active ? 'var(--lab-accent)' : 'var(--lab-text-2)',
      border:     active ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
      fontWeight: active ? 600 : 400,
      transition: 'background 0.1s, color 0.1s, border-color 0.1s',
    }}>{children}</button>
  )
}

// Effect on/off row with an optional trailing control (e.g. the tint colour).
function FxToggle({ label, on, onToggle, children }: {
  label: string; on: boolean; onToggle: () => void; children?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontSize: 11, color: on ? 'var(--lab-text)' : 'var(--lab-text-3)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {children}
        <button onClick={onToggle} title={on ? 'On' : 'Off'} style={{
          width: 34, height: 18, borderRadius: 10, padding: 0, cursor: 'pointer',
          border: `1px solid ${on ? 'var(--lab-accent)' : 'var(--lab-border)'}`,
          background: on ? 'var(--lab-accent)' : 'var(--lab-divider)', position: 'relative',
          transition: 'background 0.12s, border-color 0.12s',
        }}>
          <span style={{
            position: 'absolute', top: 1, left: on ? 17 : 1, width: 14, height: 14,
            borderRadius: '50%', background: 'var(--lab-surface)', transition: 'left 0.15s',
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }} />
        </button>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DeformLab({ embedded, initialPresetId, presetHandleRef, presetSlot }: {
  embedded?: boolean
  initialPresetId?: string
  presetHandleRef?: { current: LabPresetHandle | null }
  presetSlot?: React.ReactNode
} = {}) {
  const [status,    setStatus]    = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message,   setMessage]   = useState('')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [modelUrl,  setModelUrl]  = useState<string | null>(null)  // raw selected model, for preview before bake
  const [fileName,  setFileName]  = useState('')

  const [deformMode, setDeformMode] = useState<DeformMode>('STRETCH')
  const [factor,     setFactor]     = useState(1.0)
  const [axis,       setAxis]       = useState<Axis>('Y')
  const [limitMin,   setLimitMin]   = useState(0)
  const [limitMax,   setLimitMax]   = useState(1)
  const [animSpeed,  setAnimSpeed]  = useState(0.8)
  const [subdivs,    setSubdivs]    = useState(0)

  const [data,          setData]        = useState<DataRow[]>(DEFAULT_DATA)
  const [dataColumns,   setDataColumns] = useState<ColumnMeta[] | undefined>(undefined)  // preset dataset's variables
  const [bindings,     setBindings]     = useState<BindingMap>({})
  const [bindingRange, setBindingRange] = useState<BindingRange>({ outMin: 0, outMax: 1 })

  const [cutColor,         setCutColor]         = useState('#cc2222')
  const [cutFaceMode,      setCutFaceMode]      = useState<'color' | 'texture'>('color')
  const [cutTextures,      setCutTextures]      = useState<string[]>([])
  const [cutTextureName,   setCutTextureName]   = useState('')
  const [cutTextureTiling, setCutTextureTiling] = useState(1)

  useEffect(() => {
    serverFetch(`${SERVER}/textures`).then(r => r.json()).then((files: string[]) => {
      setCutTextures(files)
      setCutTextureName(prev => prev || files[0] || '')
    }).catch(() => {})
  }, [])

  const [presets,        setPresets]        = useState<SceneSave[]>(() => loadDeformPresets())
  const [selPresetId,    setSelPresetId]    = useState('')
  const [saveName,       setSaveName]       = useState<string | null>(null)  // null = hidden, string = editing
  const [lastShape,      setLastShape]      = useState<Shape | null>(null)
  const [pendingAutoRun, setPendingAutoRun] = useState<Shape | null>(null)
  const [fx,             setFx]             = useState<StressFx>(FX_OFF)  // deformation stress effects
  // Reference is derived from the current dataset (not the preset): choosing a
  // dataset with a reference shows its card, auto-opening when it changes.
  const reference = useMemo(() => referenceForData(data), [data])
  const [showReference,  setShowReference]  = useState(false)
  useEffect(() => { setShowReference(!!reference) }, [reference])
  const [effectData,     setEffectData]     = useState(false)  // effect view steps through data labels (preset-only)

  const [draggingField,   setDraggingField]   = useState<DataField | null>(null)
  const [dragOverProp,    setDragOverProp]    = useState<string | null>(null)
  const [showAdvanced,    setShowAdvanced]    = useState(false)

  // Dynamic/Compare view + the Dynamic playback options.
  const [view,       setView]       = useState<LabView>('dynamic')
  const [dynMode,    setDynMode]    = useState<DynMode>('smooth')
  const [showLabels, setShowLabels] = useState(true)
  // const [view2, setView2] = useState<ViewType | null>(null)

  const fileRef   = useRef<File | null>(null)
  const info      = MODE_INFO[deformMode]
  const isAngle   = deformMode === 'TWIST'
  const isSlice   = deformMode === 'SLICE'
  const isLoading = status === 'loading'
  // Map the Dynamic/Compare bar onto the internal view types. Compare = the old
  // static comparison. Dynamic plays the effect: smooth = continuous morph
  // (old effect view), transition = stepping through the data categories (old
  // dynamic view). SLICE has a single animation, so the mode toggle is hidden
  // and Dynamic always plays it.
  const view1: ViewType = view === 'compare'
    ? 'static'
    : isSlice ? 'dynamic' : (dynMode === 'smooth' ? 'effect' : 'dynamic')
  // Identity of what's shown — changes on a new model/shape or a view switch (they
  // have different layouts), but stays constant across re-simulations, so the
  // camera only re-frames on a real load, not on every Run.
  const fitKey    = `${modelUrl ?? lastShape ?? ''}|${view1}`
  const dataMin   = Math.min(...data.map(r => r.value))
  const dataMax   = Math.max(...data.map(r => r.value))


  const handleModeChange = useCallback((mode: DeformMode) => {
    setDeformMode(mode)
    setFactor(mode === 'TWIST' ? 180 : mode === 'SLICE' ? 50 : 1.0)
    // Auto-bind percentage when entering SLICE so baking uses proportional cuts by default.
    setBindings(mode === 'SLICE' ? { factor: 'percentage' } : {})
    setBindingRange({ outMin: 0, outMax: 1 })
  }, [])

  const savePreset = useCallback((name: string) => {
    const save: SceneSave = {
      id: Date.now().toString(), name,
      createdAt: new Date().toISOString(),
      // Store the shape identifier so loading can re-run automatically.
      // No blob data — the shape is always re-generatable.
      data: { shape: lastShape, fileName, deformMode, factor, axis, limitMin, limitMax, animSpeed, subdivs, bindings, bindingRange, cutColor, fx, dataRows: data, effectData },
    }
    const next = [save, ...presets]
    setPresets(next); persistDeformPresets(next)
    setSelPresetId(save.id); setSaveName(null)
    return save
  }, [lastShape, fileName, deformMode, factor, axis, limitMin, limitMax, animSpeed, subdivs, bindings, bindingRange, cutColor, fx, data, effectData, presets])

  const loadPreset = useCallback((id: string) => {
    const save = presets.find(p => p.id === id) ?? bundledLabPresets('deform').find(p => p.id === id)
    if (!save) return
    const d = save.data as Record<string, unknown>
    // Legacy "Stretch - earth" preset (saved before fx / dataset / reference existed)
    // gets seeded with the earth defaults; newer presets restore their saved values.
    const presetName = save.name.trim().toLowerCase()
    const isEarth = presetName === STRESS_PRESET_NAME
    const isWhale = presetName.includes(WHALE_PRESET_MATCH)
    // Merge over FX_OFF so presets saved before newer fx fields still get defaults.
    const savedFx = d.fx as Partial<StressFx> | undefined
    const baseFx  = savedFx ? { ...FX_OFF, ...savedFx } : (isEarth ? FX_EARTH : FX_OFF)
    // The earth preset always shows its cracks, even if it was saved before them.
    setFx(isEarth ? { ...baseFx, ...FX_EARTH_CRACKS } : baseFx)
    const savedRows = d.dataRows as DataRow[] | undefined
    // Each preset auto-loads its dataset (pinned, so it updates even if the preset
    // was saved with older rows). Every dataset carries its own variable labels
    // shown in the data panel; anything else is the generic dataset.
    // Setting the dataset drives the reference automatically (derived from data).
    if (isWhale)        { setData(WHALE_DATA); setDataColumns(WHALE_COLUMNS) }
    else if (isEarth)   { setData(EARTH_DATA); setDataColumns(EARTH_COLUMNS) }
    else if (savedRows) { setData(savedRows);  setDataColumns(DATASET_GENERIC.columns) }
    else                  setDataColumns(DATASET_GENERIC.columns)
    setEffectData((d.effectData as boolean | undefined) ?? isEarth)
    if (d.deformMode)        setDeformMode(d.deformMode as DeformMode)
    if (d.factor != null)    setFactor(d.factor as number)
    if (d.axis)              setAxis(d.axis as Axis)
    if (d.limitMin != null)  setLimitMin(d.limitMin as number)
    if (d.limitMax != null)  setLimitMax(d.limitMax as number)
    if (d.animSpeed != null) setAnimSpeed(d.animSpeed as number)
    if (d.subdivs != null)   setSubdivs(d.subdivs as number)
    // Whale preset slices proportionally to each country's share, so pin the binding.
    if (isWhale)             setBindings({ factor: 'percentage' })
    else if (d.bindings)     setBindings(d.bindings as BindingMap)
    if (d.bindingRange)      setBindingRange(d.bindingRange as BindingRange)
    if (d.cutColor)          setCutColor(d.cutColor as string)
    // Clear old result, then re-run automatically.
    setResultUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    const shape     = d.shape    as Shape  | null
    const savedFile = d.fileName as string | null | undefined
    if (shape === 'sphere' || shape === 'cube') {
      setModelUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
      setPendingAutoRun(shape)
    } else if (savedFile) {
      // Load the model: prefer the bundled model that ships with the app (works
      // on the static site); fall back to the server's /models route; only then
      // ask for a re-upload.
      const applyBlob = (blob: Blob) => {
        const file = new File([blob], savedFile, { type: 'model/gltf-binary' })
        fileRef.current = file
        setFileName(savedFile)
        setModelUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob) })
        setStatus('idle'); setMessage('')
        setPendingAutoRun('model')
      }
      const baseName = savedFile.replace(/\.(glb|gltf)$/i, '')
      const bundled  = MODEL_PRESETS.find(m => m.name === baseName)
      setStatus('loading'); setMessage(`Loading ${savedFile}…`)
      const source = bundled
        ? fetch(bundled.url).then(r => { if (!r.ok) throw new Error('not found'); return r.blob() })
        : serverFetch(`${SERVER}/models/${encodeURIComponent(savedFile)}`).then(r => { if (!r.ok) throw new Error('not found'); return r.blob() })
      source
        .then(applyBlob)
        .catch(() => { setStatus('idle'); setMessage(`Re-upload ${savedFile} to run`) })
    } else {
      setStatus('idle'); setMessage('')
    }
  }, [presets])

  const deletePreset = useCallback((id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next); persistDeformPresets(next)
    if (selPresetId === id) setSelPresetId('')
  }, [presets, selPresetId])

  // Hub-driven preset load: when the global dropdown picks one of this lab's presets.
  useEffect(() => {
    if (initialPresetId) loadPreset(initialPresetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPresetId])

  // Expose save/delete to the hub's global preset row while this lab is active.
  useEffect(() => {
    if (!presetHandleRef) return
    presetHandleRef.current = { save: savePreset as (n: string) => SceneSave, remove: deletePreset }
    return () => { if (presetHandleRef.current?.save === savePreset) presetHandleRef.current = null }
  }, [presetHandleRef, savePreset, deletePreset])

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) return
    fileRef.current = file
    setFileName(file.name)
    // Blob URL so the raw model can be previewed in the viewport before baking.
    setModelUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file) })
    setResultUrl(null); setStatus('idle'); setMessage('')
  }, [])

  const run = useCallback(async (shape: Shape) => {
    if (shape === 'model' && !fileRef.current) { setMessage('Drop a GLB first'); return }
    // Built-in shapes have no client-side model to preview/animate.
    if (shape !== 'model') setModelUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setStatus('loading'); setMessage('Blender is running…')
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    try {
      let res: Response
      if (isSlice) {
        // Build N+1 boundary values; Blender isolates each segment [b[i], b[i+1]]
        // The data binding drives the cut sizes in every view — the bake happens
        // once, so gating this on the active view would freeze equal segments in.
        let cutBoundaries: number[]
        if (bindings.factor === 'percentage') {
          // Cumulative sum of percentages → each segment width ∝ percentage value.
          // e.g. [35,25,20,15,5] → [0, 0.35, 0.60, 0.80, 0.95, 1.0]
          let cum = 0
          const bds = [0]
          for (const row of data) { cum += row.percentage; bds.push(cum / 100) }
          cutBoundaries = bds
        } else if (bindings.factor === 'value') {
          // Each value mapped to a cumulative boundary via outMin/outMax range.
          const perRow = data.map(row => {
            const norm = (row.value - dataMin) / Math.max(dataMax - dataMin, 0.001)
            return Math.max(0.005, Math.min(0.995, bindingRange.outMin + norm * (bindingRange.outMax - bindingRange.outMin)))
          })
          cutBoundaries = [0, ...perRow]
        } else {
          // Equal segments: [0, 1/n, 2/n, ..., 1]
          const n = data.length
          cutBoundaries = Array.from({ length: n + 1 }, (_, k) => k / n)
        }
        const fd = new FormData()
        fd.append('shape', shape === 'model' ? 'model' : shape)
        if (shape === 'model') fd.append('model', fileRef.current!)
        fd.append('cutPositions', JSON.stringify(cutBoundaries))
        fd.append('axis', axis)
        fd.append('cutColor', cutColor)
        fd.append('cutTextureName', cutFaceMode === 'texture' ? cutTextureName : '')
        fd.append('cutTextureTiling', cutTextureTiling.toString())
        res = await serverFetch(`${SERVER}/slice`, { method: 'POST', body: fd })
      } else {
        const bf = isAngle ? (factor * Math.PI) / 180 : factor
        const qs = `deformMode=${deformMode}&factor=${bf}&axis=${axis}&limitMin=${limitMin}&limitMax=${limitMax}&subdivs=${subdivs}`
        if (shape === 'sphere')    res = await serverFetch(`${SERVER}/deform/sphere?${qs}`)
        else if (shape === 'cube') res = await serverFetch(`${SERVER}/deform/cube?${qs}`)
        else {
          const fd = new FormData()
          fd.append('model', fileRef.current!)
          fd.append('deformMode', deformMode); fd.append('factor', bf.toString())
          fd.append('axis', axis); fd.append('limitMin', limitMin.toString())
          fd.append('limitMax', limitMax.toString()); fd.append('subdivs', subdivs.toString())
          res = await serverFetch(`${SERVER}/deform`, { method: 'POST', body: fd })
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? res.statusText)
      }
      setResultUrl(URL.createObjectURL(await res.blob()))
      setStatus('done'); setMessage(''); setLastShape(shape)
    } catch (e: unknown) {
      setStatus('error'); setMessage(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [isSlice, deformMode, factor, isAngle, axis, limitMin, limitMax, subdivs, resultUrl,
      bindings, bindingRange, data, dataMin, dataMax, cutColor, cutFaceMode, cutTextureName, cutTextureTiling])

  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl) }, [resultUrl])
  useEffect(() => () => { if (modelUrl) URL.revokeObjectURL(modelUrl) }, [modelUrl])

  // Always keep a ref to the latest `run` so the auto-run effect can call it
  // after state has already been updated by loadPreset (avoids stale closure).
  const runLatestRef = useRef(run)
  useEffect(() => { runLatestRef.current = run })  // after every render

  useEffect(() => {
    if (!pendingAutoRun) return
    setPendingAutoRun(null)
    runLatestRef.current(pendingAutoRun)
  }, [pendingAutoRun])

  const handleDrop = (e: React.DragEvent, prop: 'factor') => {
    e.preventDefault(); setDragOverProp(null)
    const field = e.dataTransfer.getData('dataField') as DataField
    if (!field) return
    setBindings(prev => ({ ...prev, [prop]: field }))
    // For SLICE + value binding: initialise outMin to dataMin/dataMax so values
    // map directly as percentages (e.g. value=3 → 3% of the object's extent).
    const initMin = isSlice && field === 'value' ? dataMin / Math.max(dataMax, 1) : 0
    setBindingRange({ outMin: initMin, outMax: 1 })
  }

  const removeBinding = (prop: keyof BindingMap) => {
    setBindings(prev => { const n = { ...prev }; delete n[prop]; return n })
    setBindingRange({ outMin: 0, outMax: 1 })
  }

  const sl: React.CSSProperties = { width: '100%', accentColor: 'var(--lab-accent)' }
  const factorDropping  = dragOverProp === 'factor'
  const factorHighlight = draggingField !== null

  return (
    <div style={{ display: 'flex', height: embedded ? '100%' : '100vh', fontFamily: 'system-ui, sans-serif', background: 'var(--lab-fill)', color: 'var(--lab-text)', position: 'relative' }}>



      {/* ── Left panel ── */}
      <div style={{ width: 268, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--lab-border)', background: 'var(--lab-surface)', position: 'relative' }}>

        <LabAdvancedToggle open={showAdvanced} onToggle={() => setShowAdvanced(v => !v)} />

        <div style={{ flex: 1, padding: embedded ? '52px 16px 18px' : '18px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>

          {!embedded && <LabNavTitle name="Deform Lab" href="/deform" />}

          {/* Embedded in the hub, the global preset dropdown replaces this row. */}
          {!embedded && (
            <LabPresetRow
              presets={presets} selPresetId={selPresetId} saveName={saveName}
              defaultSaveName={`${MODE_INFO[deformMode].label} ${new Date().toLocaleDateString()}`}
              onSelect={loadPreset} onSave={savePreset} onDelete={() => deletePreset(selPresetId)}
              setSaveName={setSaveName} setSelPresetId={setSelPresetId}
            />
          )}

          {/* Effect */}
          <Sec>
            <SLabel>Effect</SLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['STRETCH','TWIST','SLICE'] as DeformMode[]).map(m => (
                <ModeBtn key={m} active={deformMode===m} onClick={() => handleModeChange(m)}>{MODE_INFO[m].label}</ModeBtn>
              ))}
            </div>
            {/* Factor. Data binding is handled automatically, so no drop target /
                binding chip is shown even when a dataset drives the cuts. */}
            {!isSlice && (
              <div style={{ borderRadius: 8, padding: '10px', border: '1px solid var(--lab-divider)', background: 'var(--lab-fill)' }}>
                <div style={{ marginBottom: 8 }}>
                  <RowLabel>{`${info.factorLabel}: ${isAngle ? Math.round(factor) + '°' : factor.toFixed(2)}`}</RowLabel>
                </div>
                <input type="range" min={info.factorMin} max={info.factorMax} step={info.factorStep}
                  value={factor} onChange={e => setFactor(Number(e.target.value))}
                  disabled={!!bindings.factor}
                  style={{ ...sl, opacity: bindings.factor ? 0.28 : 1 }} />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <RowLabel>Axis</RowLabel>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['X','Y','Z'] as Axis[]).map(a => (
                  <ModeBtn key={a} active={axis===a} onClick={() => setAxis(a)}>{a}</ModeBtn>
                ))}
              </div>
            </div>

            {/* Cut-face material — SLICE only */}
            {isSlice && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <SLabel>Cut face</SLabel>
                {/* Mode toggle */}
                <div style={{ display: 'flex', background: 'var(--lab-fill)', borderRadius: 6, padding: 2, gap: 2 }}>
                  {(['color', 'texture'] as const).map(m => (
                    <button key={m} onClick={() => setCutFaceMode(m)} style={{
                      flex: 1, padding: '4px 0', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: cutFaceMode === m ? 'var(--lab-surface)' : 'transparent',
                      color: cutFaceMode === m ? 'var(--lab-text)' : 'var(--lab-text-3)',
                      fontSize: 10, fontFamily: 'inherit', textTransform: 'capitalize',
                    }}>{m}</button>
                  ))}
                </div>
                {cutFaceMode === 'color' ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input type="color" value={cutColor} onChange={e => setCutColor(e.target.value)}
                      style={{ width: 34, height: 28, padding: 2, background: 'none', border: '1px solid var(--lab-border)', borderRadius: 5, cursor: 'pointer' }} />
                    <span style={{ fontSize: 11, color: 'var(--lab-text-2)' }}>{cutColor}</span>
                  </div>
                ) : (
                  <>
                    <select value={cutTextureName} onChange={e => setCutTextureName(e.target.value)}
                      style={{ width: '100%', background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderRadius: 6, color: 'var(--lab-text)', fontSize: 10, padding: '5px 7px', outline: 'none', fontFamily: 'inherit' }}>
                      {cutTextures.map(t => <option key={t} value={t}>{texLabel(t)}</option>)}
                    </select>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <RowLabel>Tiling: {cutTextureTiling.toFixed(1)}×</RowLabel>
                      <input type="range" min={0.5} max={10} step={0.5} value={cutTextureTiling}
                        onChange={e => setCutTextureTiling(Number(e.target.value))} style={sl} />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Limit + anim speed — not applicable for SLICE */}
            {!isSlice && (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <RowLabel>Limit: {Math.round(limitMin*100)}% → {Math.round(limitMax*100)}%</RowLabel>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: '#555566' }}>From</span>
                    <input type="range" min={0} max={0.99} step={0.01} value={limitMin}
                      onChange={e => setLimitMin(Math.min(Number(e.target.value), limitMax - 0.01))}
                      style={{ ...sl, flex: 1 }} />
                    <span style={{ fontSize: 10, color: '#555566' }}>To</span>
                    <input type="range" min={0.01} max={1} step={0.01} value={limitMax}
                      onChange={e => setLimitMax(Math.max(Number(e.target.value), limitMin + 0.01))}
                      style={{ ...sl, flex: 1 }} />
                  </div>
                </div>
                {/* Animation speed moved to the Dynamic view's playback options. */}
              </>
            )}
          </Sec>

          <LabModelSection
            fileName={fileName} onFile={handleFile} onRun={() => run('model')}
            isLoading={isLoading} message={message} status={status} inputId="glb-deform-input"
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

      <LabAdvancedPanel open={showAdvanced}>
        <Sec>
          <SLabel>Stress Effects</SLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <FxToggle label="Tint" on={fx.tint} onToggle={() => setFx(f => ({ ...f, tint: !f.tint }))}>
              <input type="color" value={fx.tintColor}
                onChange={e => setFx(f => ({ ...f, tintColor: e.target.value }))}
                title="Effect colour (tint / glow / cracks)"
                style={{ width: 26, height: 18, padding: 0, border: '1px solid var(--lab-border)', borderRadius: 4, background: 'none', cursor: 'pointer' }} />
            </FxToggle>
            <FxToggle label="Distortion"    on={fx.distort}    onToggle={() => setFx(f => ({ ...f, distort: !f.distort }))} />
            <FxToggle label="Emissive glow" on={fx.glow}       onToggle={() => setFx(f => ({ ...f, glow: !f.glow }))} />
            <FxToggle label="Cracks"        on={fx.cracks}     onToggle={() => setFx(f => ({ ...f, cracks: !f.cracks }))} />
            {fx.cracks && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 6, marginTop: -2 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <RowLabel>Density: {fx.crackDensity.toFixed(1)}</RowLabel>
                  <input type="range" min={1} max={16} step={0.5} value={fx.crackDensity}
                    onChange={e => setFx(f => ({ ...f, crackDensity: Number(e.target.value) }))}
                    style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <RowLabel>Thickness: {fx.crackWidth.toFixed(2)}</RowLabel>
                  <input type="range" min={0.02} max={0.35} step={0.01} value={fx.crackWidth}
                    onChange={e => setFx(f => ({ ...f, crackWidth: Number(e.target.value) }))}
                    style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
                </div>
              </div>
            )}
            <FxToggle label="Desaturate"    on={fx.desaturate} onToggle={() => setFx(f => ({ ...f, desaturate: !f.desaturate }))} />
          </div>
        </Sec>
        <Sec>
          <SLabel>Mesh</SLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <RowLabel>Remesh detail: {subdivs === 0 ? 'off' : subdivs}</RowLabel>
            <input type="range" min={0} max={4} step={1} value={subdivs}
              onChange={e => setSubdivs(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
          </div>
        </Sec>
        <Sec>
          <SLabel>Quick Shapes</SLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => run('sphere')} disabled={isLoading} style={secBtnSt(isLoading)}>Sphere</button>
            <button onClick={() => run('cube')}   disabled={isLoading} style={secBtnSt(isLoading)}>Cube</button>
          </div>
        </Sec>
      </LabAdvancedPanel>

      {/* ── Viewport ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>

        <div style={{ flex: 1, position: 'relative' }}>
          <ViewCanvas viewType={view1} resultUrl={resultUrl} modelUrl={modelUrl} baking={isLoading} fitKey={fitKey} animSpeed={animSpeed} showLabels={showLabels}
            data={data} bindingRange={bindingRange} deformMode={deformMode} axis={axis} fx={fx} playData={effectData} />
        </div>

        {/* LEGACY two-view split — commented out
        {view2 !== null && (
          <div style={{ flex: 1, position: 'relative', borderTop: '1px solid #1e1e2a' }}>
            <ViewCanvas viewType={view2} resultUrl={resultUrl} animSpeed={animSpeed}
              data={data} bindings={bindings} bindingRange={bindingRange} deformMode={deformMode} axis={axis} />
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
          showLabels, onShowLabels: setShowLabels,
          speed: animSpeed, onSpeed: setAnimSpeed,
          // SLICE has one animation → always smooth, no mode toggle.
          ...(isSlice ? {} : { mode: dynMode, onMode: setDynMode }),
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

// ── Style constants ───────────────────────────────────────────────────────────

const numInp: React.CSSProperties = {
  background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderRadius: 5,
  color: 'var(--lab-text)', padding: '3px 7px', fontSize: 11, outline: 'none', width: 54,
}

