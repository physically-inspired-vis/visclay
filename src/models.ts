import { MarkShape } from './types'

// ── Model collections ─────────────────────────────────────────────────────────
// Each folder under src/assets/ named "models" (the master set — everything) or
// "models - <name>" (a curated subset) is a collection. Drop a folder in and its
// models show up under that collection's name; no code changes needed.
const glbMap = import.meta.glob('./assets/*/*.{glb,gltf}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface ModelPreset {
  name: string
  url:  string
}

// The default collection: the plain "models" folder, holding everything.
export const MASTER_COLLECTION = 'master'

// collection name → its models
const collections: Record<string, ModelPreset[]> = {}
for (const [path, url] of Object.entries(glbMap)) {
  const seg    = path.split('/')
  const folder = seg[seg.length - 2]                 // "models" | "models - CO2" | …
  if (!/^models(\s*-\s*.+)?$/i.test(folder)) continue // ignore non-model folders (e.g. textures)
  const name   = /^models$/i.test(folder)
    ? MASTER_COLLECTION
    : folder.replace(/^models\s*-\s*/i, '').trim()   // "models - CO2" → "CO2"
  const file   = seg[seg.length - 1].replace(/\.(glb|gltf)$/i, '')
  ;(collections[name] ||= []).push({ name: file, url })
}
for (const k of Object.keys(collections)) collections[k].sort((a, b) => a.name.localeCompare(b.name))

export const MODEL_COLLECTIONS = collections

// Ordered names for the picker: master first, then the rest alphabetically.
export const MODEL_COLLECTION_NAMES: string[] = Object.keys(collections).sort((a, b) =>
  a === MASTER_COLLECTION ? -1 : b === MASTER_COLLECTION ? 1 : a.localeCompare(b))

/** Models available in a collection (falls back to master, then empty). */
export function modelsForCollection(name: string): ModelPreset[] {
  return collections[name] ?? collections[MASTER_COLLECTION] ?? []
}

/** Display label for a collection name. */
export function collectionLabel(name: string): string {
  return name === MASTER_COLLECTION ? 'Master (all)' : name
}

// The master set (everything) — the default list used when no collection is chosen.
export const MODEL_PRESETS: ModelPreset[] = collections[MASTER_COLLECTION] ?? Object.values(collections).flat()

// name → url across ALL collections (master preferred), so a saved scene resolves
// its models regardless of which collection is currently active.
const byName: Record<string, string> = {}
for (const c of [MASTER_COLLECTION, ...MODEL_COLLECTION_NAMES.filter(n => n !== MASTER_COLLECTION)]) {
  for (const m of collections[c] ?? []) if (!(m.name in byName)) byName[m.name] = m.url
}

// Per-model scale multipliers applied on top of the automatic normalization.
export const MODEL_SCALE_OVERRIDES: Record<string, number> = {
  drum:     0.1,
  clarinet: 1.2,
  harp:     1.1,
}

// Re-resolve a custom model config after loading from a save.
// Blob URLs expire when the page is closed, so user-imported files fall back to box.
// Preset models are re-resolved by name from the discovered collections.
export function resolveCustomModel<T extends {
  shape: MarkShape
  customModelUrl?:    string
  customModelHasMat?: boolean
  customModelName?:   string
}>(config: T): T {
  if (config.shape !== 'custom') return config
  const url = config.customModelName ? byName[config.customModelName] : undefined
  if (url) return { ...config, customModelUrl: url }
  // Blob URLs are session-only — fall back to box
  if (!config.customModelUrl || config.customModelUrl.startsWith('blob:')) {
    return { ...config, shape: 'box' as MarkShape, customModelUrl: undefined, customModelHasMat: undefined }
  }
  return config
}
