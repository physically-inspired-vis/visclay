/**
 * LabShared.tsx
 * Single source of truth for all shared layout, types, constants, and UI
 * across every physics lab (Deform, Shatter, Particles, Fluid…).
 * Change here → changes everywhere.
 */

import { useState, useEffect, useRef } from 'react'
import { type SceneSave } from './SaveLoadModal'
import BUNDLED_LAB_PRESETS from './lab-presets.json'

// ── Server fetch (adds ngrok bypass header) ───────────────────────────────────

export function serverFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'ngrok-skip-browser-warning': '1', ...(init?.headers ?? {}) },
  })
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type { SceneSave }
export type Shape     = 'model' | 'sphere' | 'cube'
export type ViewType  = 'effect' | 'static' | 'dynamic'
export type DataField = 'value' | 'category' | 'percentage'
export interface DataRow { category: string; value: number; percentage: number }

export type ColType = 'text' | 'number' | 'percent'
export interface ColumnMeta { field: DataField; label: string; type: ColType }

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_DATA: DataRow[] = [
  { category: 'Category A', value: 3,   percentage: 35 },
  { category: 'Category B', value: 45,  percentage: 25 },
  { category: 'Category C', value: 60,  percentage: 20 },
  { category: 'Category D', value: 88,  percentage: 15 },
  { category: 'Category E', value: 100, percentage: 5  },
]

export const ALL_LAB_LINKS = [
  { label: 'Deform Lab',    href: '/deform'    },
  { label: 'Shatter Lab',   href: '/shatter'   },
  { label: 'Particles Lab', href: '/particles' },
  { label: 'Fluid Lab',     href: '/fluid'     },
]

// ── Cross-lab presets ─────────────────────────────────────────────────────────
// Presets are stored per-lab under their own localStorage key. These helpers let
// the hub read/aggregate every lab's presets into one global dropdown.

export type LabId = 'deform' | 'shatter' | 'particles' | 'fluid'

export const LAB_PRESET_KEYS: Record<LabId, string> = {
  deform:    'phys_tool_deform_presets',
  shatter:   'phys_tool_shatter_presets',
  particles: 'phys_tool_particle_presets',
  fluid:     'phys_tool_fluid_presets',
}

export const LAB_LABELS: Record<LabId, string> = {
  deform: 'Deform', shatter: 'Shatter', particles: 'Particles', fluid: 'Fluid',
}

export interface GlobalPreset { lab: LabId; id: string; name: string; createdAt: string }

const LAB_DEFAULTS = BUNDLED_LAB_PRESETS as unknown as Record<LabId, SceneSave[]>

/** Bundled default presets that ship with the app for a given lab. */
export function bundledLabPresets(lab: LabId): SceneSave[] {
  return LAB_DEFAULTS[lab] ?? []
}

// Presets = the user's own (localStorage) plus bundled defaults that ship with
// the app. A localStorage preset with the same id overrides its bundled twin,
// so exported defaults don't duplicate on the browser they came from.
export function readLabPresets(lab: LabId): SceneSave[] {
  let stored: SceneSave[] = []
  try { stored = JSON.parse(localStorage.getItem(LAB_PRESET_KEYS[lab]) ?? '[]') } catch { stored = [] }
  const bundled = LAB_DEFAULTS[lab] ?? []
  const ids = new Set(stored.map(p => p.id))
  return [...stored, ...bundled.filter(p => !ids.has(p.id))]
}

/** Every preset across every lab, tagged with which lab it belongs to. */
export function readAllPresets(): GlobalPreset[] {
  const out: GlobalPreset[] = []
  ;(Object.keys(LAB_PRESET_KEYS) as LabId[]).forEach(lab => {
    readLabPresets(lab).forEach(p => out.push({ lab, id: p.id, name: p.name, createdAt: p.createdAt }))
  })
  return out
}

/** Download every lab's saved presets as one JSON ({ deform: [...], fluid: [...], … }).
 * Used to capture localStorage presets so they can be bundled with the app. */
export function exportAllLabPresets(): number {
  const bundle: Record<string, SceneSave[]> = {}
  let total = 0
  ;(Object.keys(LAB_PRESET_KEYS) as LabId[]).forEach(lab => {
    const items = readLabPresets(lab)
    bundle[lab] = items
    total += items.length
  })
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = 'lab-presets.json'
  a.click()
  URL.revokeObjectURL(url)
  return total
}

/**
 * Handle a lab exposes to the hub so the hub's global preset row can save/delete
 * against whichever lab is currently active. `save` returns the created preset so
 * the hub can select it.
 */
export interface LabPresetHandle {
  save:   (name: string) => SceneSave
  remove: (id: string) => void
}

export const VIEW_LABELS: Record<ViewType, string> = {
  effect: 'Effect', static: 'Static', dynamic: 'Dynamic',
}
const VIEW_OPTIONS: ViewType[] = ['effect', 'static', 'dynamic']

export const DEFAULT_COLUMNS: ColumnMeta[] = [
  { field: 'category',   label: 'category',   type: 'text'    },
  { field: 'value',      label: 'value',       type: 'number'  },
  { field: 'percentage', label: 'percentage',  type: 'percent' },
]

// ── Datasets ──────────────────────────────────────────────────────────────────
// The datasets available in the data panel dropdown. Each preset seeds the
// matching one on load. `percentage` is internal encoding; the shown variables
// are defined by `columns`.

export interface Dataset { name: string; data: DataRow[]; columns: ColumnMeta[]; reference?: PresetReference }

// Whale catches by country — percentage is each country's share of the total.
const WHALE_CATCHES: [string, number][] = [
  ['Norway', 660], ['Japan', 520], ['Iceland', 184], ['Denmark', 158],
  ['Russia', 125], ['USA', 49], ['South Korea', 16], ['Canada', 2],
]
const WHALE_TOTAL = WHALE_CATCHES.reduce((s, [, v]) => s + v, 0)

export const DATASET_WHALE: Dataset = {
  name: 'Whale catches',
  data: WHALE_CATCHES.map(([category, value]) => ({
    category, value, percentage: Math.round((value / WHALE_TOTAL) * 1000) / 10,
  })),
  columns: [
    { field: 'category', label: 'Country', type: 'text'   },
    { field: 'value',    label: 'Catches', type: 'number' },
  ],
  reference: {
    title: 'Catches of whales by country',
    image: 'noway-norway.png',
    link:  'https://www.behance.net/gallery/87757735/Chit-Chart',
  },
}

export const DATASET_POLLUTION: Dataset = {
  name: 'Air pollution',
  data: [
    { category: 'Copenhagen', value: 9,  percentage: 10  },
    { category: 'Paris',      value: 14, percentage: 15  },
    { category: 'Athens',     value: 22, percentage: 24  },
    { category: 'Beijing',    value: 55, percentage: 60  },
    { category: 'Delhi',      value: 92, percentage: 100 },
  ],
  columns: [
    { field: 'category', label: 'City',  type: 'text'   },
    { field: 'value',    label: 'PM2.5', type: 'number' },
  ],
  reference: {
    title: 'WHO Ambient Air Quality Database',
    image: 'air-pollution.png',
    link:  'https://www.who.int/data/gho/data/themes/air-pollution/who-air-quality-database',
  },
}

export const DATASET_EARTH: Dataset = {
  name: 'Earth stretch',
  data: [
    { category: '1972', value: 1.0, percentage: 0  },
    { category: '1990', value: 1.2, percentage: 20 },
    { category: '2000', value: 1.4, percentage: 40 },
    { category: '2010', value: 1.7, percentage: 70 },
    { category: '2026', value: 1.9, percentage: 90 },
  ],
  columns: [
    { field: 'category', label: 'Year',   type: 'text'   },
    { field: 'value',    label: 'Earths', type: 'number' },
  ],
  reference: {
    title: 'How many Earths needed in a year?',
    image: 'earth-overshoot.png',
    link:  'https://overshoot.footprintnetwork.org/newsroom/past-earth-overshoot-days-/',
  },
}

// US bank failures per year — value doubles as the shatter piece count.
export const DATASET_BANK: Dataset = {
  name: 'Bank failures',
  data: [
    { category: '2007', value: 3,   percentage: 2   },
    { category: '2008', value: 25,  percentage: 16  },
    { category: '2009', value: 140, percentage: 89  },
    { category: '2010', value: 157, percentage: 100 },
    { category: '2011', value: 92,  percentage: 59  },
  ],
  columns: [
    { field: 'category', label: 'Year',          type: 'text'   },
    { field: 'value',    label: 'Bank failures', type: 'number' },
  ],
  reference: {
    title: 'Bank failures by year',
    image: 'bank-failures.png',   // public/assets/references/
    link:  'https://www.fdic.gov/resources/resolutions/bank-failures/in-brief/2007',
  },
}

export const DATASET_GENERIC: Dataset = {
  name: 'Generic data',
  data: DEFAULT_DATA,
  columns: DEFAULT_COLUMNS,
}

export const DATASETS: Dataset[] = [DATASET_WHALE, DATASET_POLLUTION, DATASET_EARTH, DATASET_BANK, DATASET_GENERIC]

// The reference bound to whichever dataset the given rows belong to (matched by
// identity — datasets picked from the panel or seeded by a preset keep the same
// array reference). Returns null for edited/unknown data. Shared by all labs so
// choosing a dataset shows its reference, preset or not.
export function referenceForData(rows: DataRow[]): PresetReference | null {
  return DATASETS.find(d => d.data === rows)?.reference ?? null
}

// Re-link deserialised rows (from a saved preset) to their canonical dataset by
// CONTENT, so the identity-based helpers (reference, dataset-driven behaviour)
// keep working after a JSON round-trip. Returns null for edited/unknown rows.
export function matchDataset(rows: DataRow[]): Dataset | null {
  return DATASETS.find(d =>
    d.data.length === rows.length &&
    d.data.every((r, i) => rows[i] != null && r.category === rows[i].category && r.value === rows[i].value)
  ) ?? null
}

// ── Style constants ───────────────────────────────────────────────────────────

// Light "Apple/iOS" theme to match the main composition interface. The 3D
// viewport stays dark; only the chrome (sidebar, panels, controls) is light.

export const floatSelSt: React.CSSProperties = {
  background: 'transparent', color: 'var(--lab-text)', border: 'none',
  fontSize: 11, cursor: 'pointer', outline: 'none', padding: '2px 4px',
}

export const floatIcoSt: React.CSSProperties = {
  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--lab-fill)', color: 'var(--lab-text-2)', border: '1px solid var(--lab-border)',
  borderRadius: 8, cursor: 'pointer', fontSize: 16, padding: 0,
}

export function secBtnSt(disabled: boolean): React.CSSProperties {
  return {
    flex: 1, padding: '8px 0', fontSize: 11, borderRadius: 6,
    cursor: disabled ? 'default' : 'pointer',
    background: disabled ? 'var(--lab-fill)' : 'var(--lab-surface)',
    color:      disabled ? '#c7c7cc' : 'var(--lab-text)',
    border: disabled ? '1px solid var(--lab-divider)' : '1px solid var(--lab-border)',
    opacity: disabled ? 0.7 : 1, fontFamily: 'inherit',
  }
}

export function priBtnSt(disabled: boolean): React.CSSProperties {
  return {
    width: '100%', padding: '9px 0', fontSize: 12, borderRadius: 6,
    cursor: disabled ? 'default' : 'pointer',
    background: disabled ? 'var(--lab-divider)' : 'var(--lab-accent)',
    color: disabled ? 'var(--lab-text-4)' : '#fff',
    border: 'none', opacity: disabled ? 1 : 1, fontWeight: 600, fontFamily: 'inherit',
  }
}

// ── Layout helpers ────────────────────────────────────────────────────────────

export function Sec({ children }: { children: React.ReactNode }) {
  return <div style={{ borderTop: '1px solid var(--lab-divider)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
}
export function SLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9, color: 'var(--lab-text-3)', textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700 }}>{children}</div>
}
export function RowLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: '#3a3a3c' }}>{children}</div>
}

// ── Spreadsheet modal ─────────────────────────────────────────────────────────

function SpreadsheetModalInner({ data, columns, onClose }: { data: DataRow[]; columns: ColumnMeta[]; onClose: () => void }) {
  const cellColor = (type: ColType) =>
    type === 'text' ? 'var(--lab-text-2)' : type === 'percent' ? '#5e5ce6' : 'var(--lab-text)'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--lab-surface)', border: '1px solid var(--lab-divider)', borderRadius: 12, padding: 24, minWidth: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lab-text)' }}>Dataset</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--lab-text-3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead>
              <tr>{columns.map(col => (
                <th key={col.field} style={{ textAlign: 'left', padding: '6px 14px', borderBottom: '1px solid var(--lab-divider)', color: 'var(--lab-text-3)', fontSize: 9, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 600, whiteSpace: 'nowrap' }}>{col.label}</th>
              ))}</tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : '#f8f8fa' }}>
                  {columns.map(col => (
                    <td key={col.field} style={{ padding: '8px 14px', borderBottom: '1px solid var(--lab-fill)', color: cellColor(col.type), fontVariantNumeric: col.type !== 'text' ? 'tabular-nums' : undefined, whiteSpace: 'nowrap' }}>
                      {col.type === 'text' ? row[col.field] : col.type === 'percent' ? `${row[col.field]}%` : row[col.field]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: 'var(--lab-text-3)' }}>{data.length} rows · {columns.length} columns</div>
      </div>
    </div>
  )
}

export { SpreadsheetModalInner as SpreadsheetModal }

// ── Lab nav title ─────────────────────────────────────────────────────────────

export function LabNavTitle({ name, href }: { name: string; href: string }) {
  const [showNav, setShowNav] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showNav) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShowNav(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showNav])

  const links = ALL_LAB_LINKS.filter(l => l.href !== href)

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setShowNav(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--lab-text)' }}>{name}</span>
        <span style={{ fontSize: 9, color: showNav ? 'var(--lab-accent)' : 'var(--lab-text-4)', marginTop: 1 }}>{showNav ? '▴' : '▾'}</span>
      </button>
      {showNav && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 100,
          background: 'var(--lab-surface)', border: '1px solid var(--lab-divider)', borderRadius: 10,
          padding: 4, minWidth: 190, boxShadow: '0 10px 32px rgba(0,0,0,0.18)',
        }}>
          {links.map(({ label, href: lhref }) => (
            <a key={lhref} href={lhref} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', borderRadius: 7, fontSize: 12,
              color: 'var(--lab-text-2)', textDecoration: 'none',
            }}>
              <span style={{ color: 'var(--lab-text-4)', fontSize: 11 }}>→</span>
              {label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Preset row ────────────────────────────────────────────────────────────────

export interface LabPresetRowProps {
  presets:        SceneSave[]
  selPresetId:    string
  saveName:       string | null
  defaultSaveName: string
  onSelect:       (id: string) => void
  onSave:         (name: string) => void
  onDelete:       () => void
  setSaveName:    (v: string | null) => void
  setSelPresetId: (v: string) => void
}

export function LabPresetRow({ presets, selPresetId, saveName, defaultSaveName, onSelect, onSave, onDelete, setSaveName, setSelPresetId }: LabPresetRowProps) {
  if (saveName !== null) {
    return (
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <input
          autoFocus type="text" value={saveName}
          onChange={e => setSaveName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && saveName.trim()) onSave(saveName.trim())
            if (e.key === 'Escape') setSaveName(null)
          }}
          placeholder="Preset name…"
          style={{ flex: 1, background: 'var(--lab-surface)', border: '1px solid var(--lab-accent)', borderRadius: 6, color: 'var(--lab-text)', fontSize: 10, padding: '5px 7px', outline: 'none', fontFamily: 'inherit' }}
        />
        <button onClick={() => { if (saveName.trim()) onSave(saveName.trim()) }} disabled={!saveName.trim()}
          style={{ background: 'var(--lab-accent)', border: '1px solid var(--lab-accent)', borderRadius: 6, cursor: 'pointer', color: '#fff', fontSize: 11, padding: '4px 9px', fontFamily: 'inherit', opacity: saveName.trim() ? 1 : 0.4 }}>✓</button>
        <button onClick={() => setSaveName(null)}
          style={{ background: 'none', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-text-3)', fontSize: 12, padding: '4px 7px', fontFamily: 'inherit' }}>✕</button>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      <select value={selPresetId}
        onChange={e => { setSelPresetId(e.target.value); onSelect(e.target.value) }}
        style={{ flex: 1, background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', color: selPresetId ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 10, padding: '5px 7px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <option value="">Presets…</option>
        {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {selPresetId && (
        <button onClick={onDelete} title="Delete preset"
          style={{ background: 'none', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-danger)', fontSize: 12, padding: '4px 7px', fontFamily: 'inherit' }}>×</button>
      )}
      <button onClick={() => setSaveName(defaultSaveName)}
        style={{ background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-accent)', fontSize: 10, padding: '5px 9px', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>Save</button>
    </div>
  )
}

// ── Model section ─────────────────────────────────────────────────────────────

export interface LabModel { name: string; url: string }

export function LabModelSection({ fileName, onFile, onRun, isLoading, message, status, inputId, models = [] }: {
  fileName: string; onFile: (f: File) => void; onRun: () => void
  isLoading: boolean; message: string; status: string; inputId: string
  models?: LabModel[]   // pre-loaded models for the dropdown (optional)
}) {
  const [loadingModel, setLoadingModel] = useState(false)

  // Fetch a bundled model URL and hand it to onFile as a File (so it can be baked).
  const pickModel = async (m: LabModel) => {
    setLoadingModel(true)
    try {
      const blob = await (await fetch(m.url)).blob()
      onFile(new File([blob], `${m.name}.glb`, { type: 'model/gltf-binary' }))
    } catch { /* ignore fetch errors */ }
    setLoadingModel(false)
  }

  // Last option opens the file picker; the rest load a pre-loaded model.
  const handleSelect = (val: string) => {
    if (val === '__upload__') { document.getElementById(inputId)!.click(); return }
    const m = models.find(x => x.url === val)
    if (m) pickModel(m)
  }

  const selSt: React.CSSProperties = {
    width: '100%', background: 'var(--lab-surface)', border: '1px solid var(--lab-border)',
    color: fileName ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 11,
    padding: '7px 8px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
  }

  return (
    <Sec>
      <SLabel>Model</SLabel>

      <select value="" onChange={e => handleSelect(e.target.value)} style={selSt}>
        <option value="">{loadingModel ? 'Loading…' : (fileName || 'Select a model…')}</option>
        {models.map(m => <option key={m.url} value={m.url}>{m.name}</option>)}
        <option value="__upload__">Upload custom GLB…</option>
      </select>
      <input id={inputId} type="file" accept=".glb,.gltf" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }} />

      <button onClick={onRun} disabled={isLoading || !fileName} style={priBtnSt(isLoading || !fileName)}>
        {isLoading ? 'Running…' : 'Run Simulation'}
      </button>
      {message && (
        <div style={{ fontSize: 10, color: status === 'error' ? 'var(--lab-danger)' : 'var(--lab-text-3)', lineHeight: 1.5 }}>{message}</div>
      )}
    </Sec>
  )
}

// ── Data panel ────────────────────────────────────────────────────────────────

function ColTypeIcon({ type }: { type: ColType }) {
  if (type === 'text') return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
      <text x="0" y="9" fontSize="9" fontWeight="700" fontFamily="system-ui,sans-serif">Aa</text>
    </svg>
  )
  if (type === 'percent') return (
    <svg width="10" height="11" viewBox="0 0 10 11" fill="currentColor">
      <text x="0" y="9" fontSize="10" fontWeight="700" fontFamily="system-ui,sans-serif">%</text>
    </svg>
  )
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" fill="currentColor">
      <text x="0" y="9" fontSize="10" fontWeight="700" fontFamily="system-ui,sans-serif">#</text>
    </svg>
  )
}

export function LabDataPanel({ data, columnsOverride, onDataChange }: {
  data: DataRow[]
  columnsOverride?: ColumnMeta[]   // variables to show for a preset-loaded dataset
  onDataChange?: (d: DataRow[]) => void
}) {
  const [selIdx, setSelIdx] = useState('')
  const [showTable, setShowTable] = useState(false)
  // Reflect the preset-seeded dataset in the dropdown (matched by its columns).
  useEffect(() => {
    const idx = columnsOverride ? DATASETS.findIndex(d => d.columns === columnsOverride) : -1
    setSelIdx(idx >= 0 ? String(idx) : '')
  }, [columnsOverride])
  const columns = selIdx !== '' ? DATASETS[Number(selIdx)].columns : (columnsOverride ?? DEFAULT_COLUMNS)

  return (
    <div style={{ borderTop: '1px solid var(--lab-divider)', padding: '12px 16px 14px', background: 'var(--lab-surface)' }}>
      {showTable && <SpreadsheetModalInner data={data} columns={columns} onClose={() => setShowTable(false)} />}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <SLabel>Data</SLabel>
        <button onClick={() => setShowTable(true)}
          style={{ padding: '3px 9px', fontSize: 9, borderRadius: 5, cursor: 'pointer', background: 'var(--lab-fill)', color: 'var(--lab-text-2)', border: '1px solid var(--lab-border)' }}>
          ⊞ Table
        </button>
      </div>
      <select
        value={selIdx}
        onChange={e => {
          const idx = e.target.value
          setSelIdx(idx)
          if (idx !== '' && onDataChange) onDataChange(DATASETS[Number(idx)].data)
        }}
        style={{ width: '100%', background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', color: selIdx !== '' ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 10, padding: '5px 7px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 8 }}
      >
        <option value="">Select dataset…</option>
        {DATASETS.map((d, i) => <option key={i} value={i}>{d.name}</option>)}
      </select>
      {/* Variables of the loaded dataset. Display-only — the interface encodes them
          automatically, so binding-by-drag is disabled for now. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {columns.map(col => (
          <div key={col.field}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 12, userSelect: 'none',
              background: 'var(--lab-fill)', border: '1px solid var(--lab-border)',
              color: 'var(--lab-text-2)', fontSize: 10,
            }}>
            <ColTypeIcon type={col.type} />
            {col.label}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Preset reference (optional side panel) ────────────────────────────────────
// A preset may carry a reference — a dataset title, an image and a source link —
// shown in a card at the bottom-right of the viewport. Images live in
// public/assets/references/.

export interface PresetReference { title: string; image: string; link: string }

const REF_ASSET_BASE = import.meta.env.BASE_URL + 'assets/references/'
/** Resolve a stored image (bare filename → references folder; full URL → as-is). */
export function refImageSrc(image: string) {
  return /^(https?:)?\/\//.test(image) || image.startsWith('/') ? image : REF_ASSET_BASE + image
}

/** Small "ⓘ Reference" button shown when the panel is hidden. */
export function ReferenceButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="Show reference"
      style={{
        position: 'absolute', bottom: 12, right: 12, zIndex: 20,
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'rgba(255,255,255,0.95)', border: '1px solid var(--lab-border)', borderRadius: 8,
        color: 'var(--lab-accent)', fontSize: 11, fontFamily: 'inherit', padding: '6px 10px', cursor: 'pointer',
      }}>
      ⓘ Reference
    </button>
  )
}

export function ReferencePanel({ reference, onClose }: { reference: PresetReference; onClose: () => void }) {
  return (
    <div style={{
      position: 'absolute', right: 12, bottom: 12, width: 300, maxHeight: '52%', zIndex: 20,
      background: 'rgba(255,255,255,0.97)', border: '1px solid var(--lab-border)', borderRadius: 12,
      boxShadow: '0 12px 40px rgba(0,0,0,0.22)', backdropFilter: 'blur(6px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '14px 14px 10px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lab-text)', lineHeight: 1.3 }}>{reference.title}</div>
        <button onClick={onClose} title="Hide reference"
          style={{ background: 'none', border: 'none', color: 'var(--lab-text-3)', cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {reference.image && (
          <img src={refImageSrc(reference.image)} alt={reference.title}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            style={{ width: '100%', borderRadius: 8, display: 'block', background: 'var(--lab-fill)' }} />
        )}
        {reference.link && (
          <a href={reference.link} target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: 'var(--lab-accent)', textDecoration: 'none', wordBreak: 'break-all', lineHeight: 1.5 }}>
            {reference.link} ↗
          </a>
        )}
      </div>
    </div>
  )
}

// ── Advanced panel toggle (side arrow on left panel edge) ─────────────────────

export function LabAdvancedToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} title={open ? 'Close advanced' : 'Open advanced'} style={{
      position: 'absolute', right: -14, top: '50%', transform: 'translateY(-50%)',
      zIndex: 40, width: 14, height: 52,
      background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderLeft: 'none',
      borderRadius: '0 6px 6px 0', cursor: 'pointer',
      color: open ? 'var(--lab-accent)' : 'var(--lab-text-4)',
      fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 0, lineHeight: 1,
    }}>{open ? '‹' : '›'}</button>
  )
}

// ── Advanced panel overlay ────────────────────────────────────────────────────

export function LabAdvancedPanel({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div style={{ position: 'absolute', left: 268, top: 0, bottom: 0, width: 200, zIndex: 30, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--lab-border)', background: 'var(--lab-surface)', boxShadow: '4px 0 24px rgba(0,0,0,0.12)' }}>
      <div style={{ flex: 1, padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--lab-text)', letterSpacing: 0.2 }}>Advanced</div>
        {children}
      </div>
    </div>
  )
}

// ── Floating view selector (legacy two-view; kept for reference) ──────────────

export function LabViewSelector({ view1, view2, onView1, onView2, onAdd, onRemove }: {
  view1: ViewType; view2: ViewType | null
  onView1: (v: ViewType) => void; onView2: (v: ViewType) => void
  onAdd: () => void; onRemove: () => void
}) {
  return (
    <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 10 }}>
      <div style={{
        pointerEvents: 'all', display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 6px 5px 14px', borderRadius: 24,
        background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)', border: '1px solid var(--lab-border)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
      }}>
        <select value={view1} onChange={e => onView1(e.target.value as ViewType)} style={floatSelSt}>
          {VIEW_OPTIONS.map(v => <option key={v} value={v}>{VIEW_LABELS[v]}</option>)}
        </select>
        {view2 !== null ? (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--lab-divider)' }} />
            <select value={view2} onChange={e => onView2(e.target.value as ViewType)} style={floatSelSt}>
              {VIEW_OPTIONS.map(v => <option key={v} value={v}>{VIEW_LABELS[v]}</option>)}
            </select>
            <button onClick={onRemove} title="Remove second view" style={floatIcoSt}>×</button>
          </>
        ) : (
          <button onClick={onAdd} title="Add second view" style={floatIcoSt}>+</button>
        )}
      </div>
    </div>
  )
}

// ── Single-view bottom toggle ─────────────────────────────────────────────────

function EffectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M7 0.5L8.3 5.7L13.5 7L8.3 8.3L7 13.5L5.7 8.3L0.5 7L5.7 5.7Z" />
    </svg>
  )
}

function StaticIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="5" height="5" rx="1.2" />
      <rect x="8" y="1" width="5" height="5" rx="1.2" />
      <rect x="1" y="8" width="5" height="5" rx="1.2" />
      <rect x="8" y="8" width="5" height="5" rx="1.2" />
    </svg>
  )
}

function DynamicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M1 7C2.5 4.5 4 9.5 5.5 7C7 4.5 8.5 9.5 10 7C11.2 5.2 12.2 8.5 13 7" />
    </svg>
  )
}

// ── Dynamic / Compare view bar ────────────────────────────────────────────────
// Replaces the old Effect/Static/Dynamic toggle. Two views: Dynamic (plays the
// effect) and Compare (the side-by-side static comparison). When Dynamic is
// active, a tune button opens a small panel with per-lab playback options —
// labs pass only the options that apply to them.

export type LabView = 'dynamic' | 'compare'
export type DynMode = 'smooth' | 'transition'

export interface DynOptions {
  showLabels?: boolean; onShowLabels?: (b: boolean) => void
  speed?: number;       onSpeed?: (n: number) => void
  mode?: DynMode;       onMode?: (m: DynMode) => void   // omit → mode toggle hidden (always smooth)
}

function ChevronUpIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: 'transform 0.16s ease', transform: open ? 'rotate(180deg)' : 'none' }}>
      <path d="M3.5 8.75L7 5.25l3.5 3.5" />
    </svg>
  )
}

const VIEW_BAR_CONFIG: { id: LabView; label: string }[] = [
  { id: 'dynamic', label: 'Dynamic' },
  { id: 'compare', label: 'Compare' },
]

export function LabViewBar({ view, onChange, options }: {
  view: LabView
  onChange: (v: LabView) => void
  options?: DynOptions
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const hasOptions = !!options && !!(options.onShowLabels || options.onSpeed || options.onMode)

  return (
    <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 10 }}>
      <div ref={ref} style={{ pointerEvents: 'all', position: 'relative' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 2,
          padding: 4, borderRadius: 20,
          background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)', border: '1px solid var(--lab-border)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
        }}>
          {hasOptions && (
            <button onClick={() => setOpen(v => !v)} title="Playback options"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 28, borderRadius: 14, border: 'none', marginRight: -4,
                background: open ? 'var(--lab-accent-soft)' : 'transparent',
                color: open ? 'var(--lab-accent)' : 'var(--lab-text-3)',
                cursor: 'pointer', transition: 'color 0.12s, background 0.12s',
              }}>
              <ChevronUpIcon open={open} />
            </button>
          )}
          {VIEW_BAR_CONFIG.map(({ id, label }) => {
            const on = view === id
            return (
              <button key={id} onClick={() => onChange(id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '6px 16px', borderRadius: 14, border: 'none',
                  background: on ? 'var(--lab-accent-soft)' : 'transparent',
                  color: on ? 'var(--lab-accent)' : 'var(--lab-text-3)',
                  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                  letterSpacing: 0.3, transition: 'color 0.12s, background 0.12s',
                }}>
                {/* Reserve the bold width always, so toggling weight never resizes the bar. */}
                <span style={{ display: 'grid' }}>
                  <span aria-hidden style={{ gridArea: '1/1', fontWeight: 600, visibility: 'hidden', height: 0 }}>{label}</span>
                  <span style={{ gridArea: '1/1', fontWeight: on ? 600 : 400 }}>{label}</span>
                </span>
              </button>
            )
          })}
        </div>

        {open && options && (
          <div style={{
            position: 'absolute', bottom: 'calc(100% + 10px)', left: 0,
            width: 216, background: 'rgba(255,255,255,0.98)', border: '1px solid var(--lab-border)',
            borderRadius: 10, padding: '12px 14px', boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
            {options.onShowLabels && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--lab-text-2)', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!options.showLabels}
                  onChange={e => options.onShowLabels!(e.target.checked)}
                  style={{ accentColor: 'var(--lab-accent)' }} />
                Show labels
              </label>
            )}
            {options.onSpeed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ fontSize: 11, color: 'var(--lab-text-2)' }}>Animation speed: {(options.speed ?? 1).toFixed(1)}×</div>
                <input type="range" min={0.1} max={3} step={0.1} value={options.speed ?? 1}
                  onChange={e => options.onSpeed!(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--lab-accent)' }} />
              </div>
            )}
            {options.onMode && (
              <div style={{ display: 'flex', gap: 5 }}>
                {(['smooth', 'transition'] as DynMode[]).map(m => {
                  const on = options.mode === m
                  return (
                    <button key={m} onClick={() => options.onMode!(m)}
                      style={{
                        flex: 1, padding: '6px 0', fontSize: 10, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                        background: on ? 'var(--lab-accent-soft)' : 'var(--lab-fill)',
                        color:      on ? 'var(--lab-accent)' : 'var(--lab-text-2)',
                        border:     on ? '1px solid var(--lab-accent)' : '1px solid var(--lab-border)',
                        fontWeight: on ? 600 : 400, textTransform: 'capitalize',
                      }}>{m}</button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
