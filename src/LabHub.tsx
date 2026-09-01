import { useState, useRef } from 'react'
import DeformLab    from './DeformLab'
import ShatterLab   from './ShatterLab'
import ParticleLab  from './ParticleLab'
import FluidLab     from './FluidLab'
import {
  type LabId, type GlobalPreset, type LabPresetHandle,
  LAB_LABELS, readAllPresets, exportAllLabPresets,
} from './LabShared'

type Probe = LabId

// Must match the labs' sidebar width
const SIDEBAR_W = 268
const BAR_H     = 44
const PANEL_BG  = 'var(--lab-surface)'

// ── Icons ─────────────────────────────────────────────────────────────────────

function DeformIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeLinecap="round">
      <path strokeWidth="1.6" d="M2 6.5C4 5.5 6.5 7.5 9 7C11.5 6.5 14 7.5 16 6.5"/>
      <path strokeWidth="1.6" d="M2 11.5C4 12.5 6.5 10.5 9 11C11.5 11.5 14 10.5 16 11.5"/>
      <path strokeWidth="1" d="M2 6.5L2 11.5M9 7L9 11M16 6.5L16 11.5" opacity="0.4"/>
    </svg>
  )
}

function ShatterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <polygon strokeWidth="1.5" points="9,2 15,6.5 13,16 5,16 3,6.5"/>
      <path strokeWidth="1" d="M9 2L7 8L13 10" opacity="0.5"/>
      <path strokeWidth="1" d="M7 8L5 16" opacity="0.5"/>
    </svg>
  )
}

function ParticlesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
      <circle cx="4.5" cy="4.5" r="1.8"/>
      <circle cx="14"  cy="3.5" r="1.8"/>
      <circle cx="8"   cy="9"   r="1.8"/>
      <circle cx="3.5" cy="14"  r="1.8"/>
      <circle cx="14"  cy="13"  r="1.8"/>
      <circle cx="10.5" cy="15" r="1.2"/>
    </svg>
  )
}

function FluidIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeLinecap="round">
      <path strokeWidth="1.6" d="M2 13C4 10 6.5 15 9 13C11.5 11 14 15 16 13"/>
      <path strokeWidth="1.3" d="M2 9C4 6 6.5 11 9 9C11.5 7 14 11 16 9" opacity="0.4"/>
    </svg>
  )
}

// ── Config ────────────────────────────────────────────────────────────────────

const PROBES: { id: Probe; label: string; short: string; Icon: () => JSX.Element }[] = [
  { id: 'deform',    label: 'Deformation', short: 'Deform',    Icon: DeformIcon    },
  { id: 'shatter',   label: 'Shattering',  short: 'Shatter',   Icon: ShatterIcon   },
  { id: 'particles', label: 'Particles',   short: 'Particles', Icon: ParticlesIcon },
  { id: 'fluid',     label: 'Fluids',      short: 'Fluid',     Icon: FluidIcon     },
]

// Composite dropdown value so two labs can't collide on a numeric preset id.
const keyOf = (lab: LabId, id: string) => `${lab}::${id}`

// ── Global preset bar ───────────────────────────────────────────────────────────

function GlobalPresetRow({
  presets, selKey, saveName, defaultSaveName,
  onSelect, onSave, onDelete, setSaveName,
}: {
  presets:         GlobalPreset[]
  selKey:          string
  saveName:        string | null
  defaultSaveName: string
  onSelect:        (key: string) => void
  onSave:          (name: string) => void
  onDelete:        () => void
  setSaveName:     (v: string | null) => void
}) {
  // Group presets under their lab for the <optgroup> labels.
  const byLab = (Object.keys(LAB_LABELS) as LabId[])
    .map(lab => ({ lab, items: presets.filter(p => p.lab === lab) }))
    .filter(g => g.items.length > 0)

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
          style={{ flex: 1, minWidth: 0, background: 'var(--lab-surface)', border: '1px solid var(--lab-accent)', borderRadius: 6, color: 'var(--lab-text)', fontSize: 10, padding: '5px 7px', outline: 'none', fontFamily: 'inherit' }}
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
      <select value={selKey}
        onChange={e => onSelect(e.target.value)}
        style={{ flex: 1, minWidth: 0, background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', color: selKey ? 'var(--lab-text)' : 'var(--lab-text-3)', borderRadius: 6, fontSize: 10, padding: '5px 7px', outline: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
        <option value="">Presets…</option>
        {byLab.map(g => (
          <optgroup key={g.lab} label={LAB_LABELS[g.lab]}>
            {g.items.map(p => <option key={keyOf(g.lab, p.id)} value={keyOf(g.lab, p.id)}>{p.name}</option>)}
          </optgroup>
        ))}
      </select>
      {selKey && (
        <button onClick={onDelete} title="Delete preset"
          style={{ background: 'none', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-danger)', fontSize: 12, padding: '4px 7px', fontFamily: 'inherit' }}>×</button>
      )}
      <button
        onClick={() => { const n = exportAllLabPresets(); if (n === 0) alert('No lab presets saved in this browser yet.') }}
        title="Export all saved lab presets as JSON"
        style={{ background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-text-3)', fontSize: 12, padding: '4px 7px', fontFamily: 'inherit' }}>⭳</button>
      <button onClick={() => setSaveName(defaultSaveName)}
        style={{ background: 'var(--lab-surface)', border: '1px solid var(--lab-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--lab-accent)', fontSize: 10, padding: '5px 9px', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>Save</button>
    </div>
  )
}

// ── Hub ───────────────────────────────────────────────────────────────────────

export default function LabHub() {
  const [active,      setActive]      = useState<Probe>('deform')
  const [presets,     setPresets]     = useState<GlobalPreset[]>(() => readAllPresets())
  const [selKey,      setSelKey]      = useState('')   // composite "lab::id" or ''
  const [pendingLoad, setPendingLoad] = useState<{ lab: Probe; id: string } | null>(null)
  const [saveName,    setSaveName]    = useState<string | null>(null)

  // The active lab writes its save/delete handle here so the global row can drive it.
  const handleRef = useRef<LabPresetHandle | null>(null)

  const refresh = () => setPresets(readAllPresets())

  const selectTab = (id: Probe) => {
    // Manual tab switch: the currently-selected preset belongs to another lab, so clear it.
    setActive(id)
    setPendingLoad(null)
    setSelKey('')
    setSaveName(null)
  }

  const selectPreset = (key: string) => {
    setSelKey(key)
    setSaveName(null)
    if (!key) { setPendingLoad(null); return }
    const [lab, id] = key.split('::') as [Probe, string]
    setActive(lab)             // switch to the preset's tab
    setPendingLoad({ lab, id }) // active lab loads it (on mount or prop change)
  }

  const savePreset = (name: string) => {
    const saved = handleRef.current?.save(name)
    refresh()
    if (saved) setSelKey(keyOf(active, saved.id))
    setSaveName(null)
  }

  const deletePreset = () => {
    if (!selKey) return
    const [, id] = selKey.split('::')
    handleRef.current?.remove(id)   // selected preset always belongs to the active lab
    refresh()
    setSelKey('')
    setPendingLoad(null)
  }

  const initialFor = (lab: Probe) => (pendingLoad?.lab === lab ? pendingLoad.id : undefined)

  // The global preset row, rendered once here but placed inside the active lab's
  // sidebar (just above its data panel) via the `presetSlot` prop.
  const presetSlot = (
    <GlobalPresetRow
      presets={presets} selKey={selKey} saveName={saveName}
      defaultSaveName={`${LAB_LABELS[active]} ${new Date().toLocaleDateString()}`}
      onSelect={selectPreset} onSave={savePreset} onDelete={deletePreset}
      setSaveName={setSaveName}
    />
  )

  return (
    <div style={{
      width: '100vw', height: '100vh', position: 'relative',
      fontFamily: 'system-ui, sans-serif',
    }}>

      {/* ── Active lab — fills the full viewport ── */}
      <div style={{ width: '100%', height: '100%' }}>
        {active === 'deform'    && <DeformLab    embedded initialPresetId={initialFor('deform')}    presetHandleRef={handleRef} presetSlot={presetSlot} />}
        {active === 'shatter'   && <ShatterLab   embedded initialPresetId={initialFor('shatter')}   presetHandleRef={handleRef} presetSlot={presetSlot} />}
        {active === 'particles' && <ParticleLab  embedded initialPresetId={initialFor('particles')} presetHandleRef={handleRef} presetSlot={presetSlot} />}
        {active === 'fluid'     && <FluidLab     embedded initialPresetId={initialFor('fluid')}     presetHandleRef={handleRef} presetSlot={presetSlot} />}
      </div>

      {/* ── Probe switcher — absolute overlay at top of the sidebar ── */}
      <div style={{
        position: 'absolute', top: 0, left: 0,
        width: SIDEBAR_W, height: BAR_H, zIndex: 50,
        background: PANEL_BG,
        borderBottom: '1px solid var(--lab-border)',
        borderRight: '1px solid var(--lab-border)',
        display: 'flex',
      }}>
        {PROBES.map(({ id, short, label, Icon }) => {
          const on = active === id
          return (
            <button
              key={id}
              onClick={() => selectTab(id)}
              title={label}
              style={{
                flex: 1,
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: 3, border: 'none', padding: '4px 4px 2px',
                borderBottom: on ? `2px solid var(--lab-accent)` : '2px solid transparent',
                background: on ? 'var(--lab-accent-soft)' : 'transparent',
                color: on ? 'var(--lab-accent)' : 'var(--lab-text-3)',
                cursor: 'pointer',
                transition: 'color 0.12s, background 0.12s, border-color 0.12s',
              }}
            >
              <Icon />
              <span style={{
                fontSize: 9, fontFamily: 'inherit', lineHeight: 1,
                fontWeight: on ? 700 : 400,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}>
                {short}
              </span>
            </button>
          )
        })}
      </div>

    </div>
  )
}
