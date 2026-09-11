// ── Composition hierarchy ─────────────────────────────────────────────────────
export type CompositionLevel = 1 | 2 | 3
export type ActiveElement = 'mark' | 'collection1' | 'collection2' | 'scene'

// ── Shared primitives ─────────────────────────────────────────────────────────
export interface Vec3 {
  x: number
  y: number
  z: number
}

// ── Mark ─────────────────────────────────────────────────────────────────────
export type MarkShape    = 'box' | 'sphere' | 'star' | 'custom'
export type MarkMaterial = 'plastic' | 'fluid' | 'glass' | 'metal' | 'iridescent' | 'emissive' | 'toon' | 'wireframe' | 'original' | 'custom'

// Structural deformation applied to mark geometry
export type StructuralDeformation = 'none' | 'fluid'

export interface StructuralConfig {
  deformation: StructuralDeformation
  fluidDistort: number  // wave amplitude  0.0 – 0.8
  fluidSpeed:   number  // wave speed      0.0 – 5.0
}

// Per-category geometry override (keyed by layer name)
export interface CategoryShapeEntry {
  shape:             MarkShape
  customModelUrl?:   string
  customModelHasMat?: boolean
  customModelName?:  string
}

// One sub-shape of a compound mark. Its transform is relative to the mark's unit
// frame (offset/size are in the same normalized space as a single mark's geometry).
export interface MarkPart {
  id:                 string
  shape:              MarkShape
  customModelUrl?:    string
  customModelHasMat?: boolean
  customModelName?:   string
  material?:          MarkMaterial   // falls back to the mark's material
  color?:             string         // falls back to the mark's color
  offset:             Vec3           // relative position (mark-unit space)
  size:               Vec3           // relative per-axis size
  orientation:        Vec3           // relative rotation (degrees)
}

export interface MarkConfig {
  // Geometry
  shape: MarkShape
  // A compound mark is a list of sub-shapes rendered together and treated as one
  // mark everywhere (scatter/stack/etc.). Absent/empty → a plain single-shape mark.
  parts?: MarkPart[]
  // Per-category shape overrides (level 2+): layer.name → shape entry
  categoryShapes?: Record<string, CategoryShapeEntry>
  // Material
  material: MarkMaterial
  color: string
  opacity?:   number   // alpha, 0–1 (default 1) — applies to any material
  roughness?: number   // 0–1 — used by the 'custom' material
  metalness?: number   // 0–1 — used by the 'custom' material
  // Spatial (applied directly at Level 1; used as instance-scale multipliers at Levels 2–3)
  position:    Vec3   // scene-space offset from origin
  scale:       number // uniform scale multiplier on top of per-axis size (default 1)
  size:        Vec3   // per-axis scale multipliers (1 = default size)
  orientation: Vec3   // rotation in degrees
  // Structural deformation
  structural: StructuralConfig
  // Custom model (only when shape === 'custom')
  customModelUrl?:    string
  customModelHasMat?: boolean
  customModelName?:   string   // display name; also used as preset lookup key on load
}

// ── Collection ────────────────────────────────────────────────────────────────
export type CollectionArrangement = 'alignment' | 'scattering' | 'stacking' | 'piling' | 'surface' | 'adjacent'

export interface CollectionConfig {
  arrangement:       CollectionArrangement
  color:             string
  // Alignment — marks in a line
  alignCount:        number    // 2–20
  alignAxis:         'X' | 'Y'
  alignSpacing:      number    // center-to-center gap (world units)
  alignAnchor:       'start' | 'center' | 'end'  // edge alignment: start=top/left, end=bottom/right
  // Scattering — marks randomly distributed in a volume
  scatterMode:           'count' | 'density'  // count: fixed number; density: particles per unit³
  scatterCount:          number    // mark count (used when scatterMode === 'count')
  scatterDimensions:     Vec3      // bounding box / sphere dimensions
  scatterDensity:        number    // particles per unit³ (used when scatterMode === 'density')
  scatterBoundingVolume?: 'box' | 'sphere'
  scatterShowBounds?:    boolean
  scatterOrientation?:   'random' | 'static'
  scatterExclusionId?:   string | null  // deprecated — migrated into `object`
  scatterEven?:          boolean
  scatterSizeAxes?:      { x: boolean; y: boolean; z: boolean }  // axes the Scatter-Size encoding grows (default Y)
  scatterExcludeObject?: boolean  // keep scattered marks out of the collection object's volume
  // Adjacent placement — marks scattered on a flat surface, bottom-aligned
  adjacentShowGrid?:     boolean  // show a reference grid on the surface
  // Stacking — marks piled in a vertical column
  stackingRandomOrient?: boolean  // give each stacked mark a random tumble
  // Piling — physics-settled pile
  pilingCount:       number    // number of marks to drop (default 10)
  // Surface placement — marks scattered onto the collection object's surface,
  // standing along its normals (e.g. mushrooms on a log)
  surfaceTargetId?:  string | null  // deprecated — migrated into `object`
  surfaceCount?:     number         // number of marks (default 24)
  surfaceScale?:     number         // mark size multiplier (default 1)
  // Optional embedded object — a decoration that belongs to this collection.
  // Rendered with the collection and used as the surface / exclusion target.
  // (Replaces linking to a global decoration by id.)
  object?:           DecorationConfig | null
}

// ── Scene ─────────────────────────────────────────────────────────────────────
export type HdriPreset =
  | 'city' | 'warehouse' | 'sunset' | 'dawn'
  | 'forest' | 'night' | 'studio' | 'apartment'

export type BackgroundMode = 'dark' | 'ocean' | 'color' | 'gradient' | 'hdri' | 'sky'

// Label occlusion: 'off' none, 'full' raycasts the whole scene (thorough, slow),
// 'optimized' raycasts only decorations (fast).
export type LabelOccludeMode = 'off' | 'full' | 'optimized'

export interface SceneConfig {
  background:  BackgroundMode
  hdriPreset:  HdriPreset
  focalLength: number
  // Background appearance
  bgColor?:          string   // 'color' mode
  bgGradientTop?:    string   // 'gradient' mode
  bgGradientBottom?: string   // 'gradient' mode
  hdriBlur?:         number   // 'hdri' background blur (0–1)
  hdriIntensity?:    number   // 'hdri' background brightness
  // Lighting
  exposure?:         number   // tone-mapping exposure
  envRotation?:      number   // HDRI rotation in degrees (reflections + hdri bg)
  // Sky ('sky' mode)
  skyElevation?:     number   // sun elevation in degrees
  skyAzimuth?:       number   // sun azimuth in degrees
  // Atmosphere / ground
  stars?:            boolean
  fog?:              boolean
  fogColor?:         string
  fogNear?:          number
  fogFar?:           number
  grid?:             boolean
  sceneTitleShow?:   boolean
  sceneTitleOffset?: number   // world-unit Y distance from origin (default 9)
  sceneTitleBelow?:  boolean  // false = above (default), true = below
  sceneLabelOcclude?: LabelOccludeMode // hide floating labels when behind geometry
}

// ── Label configuration ───────────────────────────────────────────────────────
export type LabelPosition = 'top' | 'bottom' | 'left' | 'right'

// Each slot holds a list of variables, shown joined with " · " (multiple
// variables can share one label position).
export interface LabelSlots {
  top:    DataVariable[]
  bottom: DataVariable[]
  left:   DataVariable[]
  right:  DataVariable[]
}

// ── Data bindings ─────────────────────────────────────────────────────────────
export type DataVariable = 'numerical' | 'categorical' | 'weight' | 'garbageType' | 'count' | 'section'

export interface DataBindings {
  markColor:     DataVariable | null
  markGeometry:  DataVariable | null  // activates per-category geometry encoding
  scatterSize:   DataVariable | null
  scatterCount:  DataVariable | null  // uses data value as scatter particle count
  c1AlignCount:  DataVariable | null
  c2AlignCount:  DataVariable | null
  markSizeX:     DataVariable | null
  markSizeY:     DataVariable | null
  markSizeZ:     DataVariable | null
  markScale:     DataVariable | null  // uniform scale of the whole mark
}

// Per-encoding multiplier applied to a numeric binding's value (e.g. ×2, ÷2).
export type BindingScale = Partial<Record<keyof DataBindings, number>>

export interface LabelConfig {
  show:      boolean
  slots:     LabelSlots
  fontSize?: number   // label text size in px (default 11)
  distance?: number   // extra offset from the object; +away / −closer (default 0)
  bold?:     boolean  // render label text bold (default false)
  italic?:   boolean  // render label text italic (default false)
  color?:    string   // label text colour (default light grey)
}

// ── Decoration ────────────────────────────────────────────────────────────────
export interface DecorationConfig {
  id:           string
  name?:        string
  shape:        MarkShape
  material:     MarkMaterial
  color:        string
  opacity?:     number   // alpha, 0–1 (default 1)
  roughness?:   number   // 0–1 — used by the 'custom' material
  metalness?:   number   // 0–1 — used by the 'custom' material
  position:     Vec3
  size:         Vec3
  orientation:  Vec3
  structural:   StructuralConfig
  customModelUrl?:    string
  customModelHasMat?: boolean
  customModelName?:   string
}

// ── Legacy (kept for existing Scene / Layer components) ───────────────────────
export interface LayerData {
  id:         string
  name:       string
  percentage: number
  color:      string
}

export interface SphereData {
  id:    string
  label: string
  value: number
  color: string
}

export type ExampleMode = 'layers' | 'fluid'
