import React, { useState } from 'react'

export interface SceneSave {
  id:        string
  name:      string
  createdAt: string
  data:      Record<string, unknown>
}

// ── Preset auto-discovery ─────────────────────────────────────────────────────

const _presetMods = import.meta.glob<{ default: Record<string, unknown> }>(
  './presets/*.json',
  { eager: true },
)

export const PRESETS: SceneSave[] = Object.entries(_presetMods).map(([path, mod]) => {
  const raw  = path.replace(/^.*\//, '').replace(/\.json$/, '')
  const name = raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return { id: `preset_${raw}`, name, createdAt: '', data: mod.default }
})

// The study scenes are the lettered presets ("A. …", "B. …", "C. …"). The Load
// dialog can filter to just these (on by default) so the study list stays clean.
const STUDY_SCENE_RE = /^[A-Za-z]\.\s/
export const isStudyScene = (s: SceneSave) => STUDY_SCENE_RE.test(s.name)

// ── Viewport thumbnail ────────────────────────────────────────────────────────

// Grab the WebGL canvas and return a small JPEG data URL for the scene preview.
// (The Canvas is created with preserveDrawingBuffer so its last frame is readable.)
export function captureThumbnail(maxW = 320): string | undefined {
  const canvas = document.querySelector('canvas')
  if (!canvas) return undefined
  try {
    const srcW  = canvas.width || maxW
    const srcH  = canvas.height || maxW
    const scale = Math.min(1, maxW / srcW)
    const w = Math.max(1, Math.round(srcW * scale))
    const h = Math.max(1, Math.round(srcH * scale))
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(canvas, 0, 0, w, h)
    return off.toDataURL('image/jpeg', 0.72)
  } catch {
    return undefined   // e.g. a tainted canvas — just skip the preview
  }
}

// ── Export helper ─────────────────────────────────────────────────────────────

export function exportScene(name: string, data: Record<string, unknown>) {
  // Embed a fresh viewport screenshot so the exported preset shows a preview.
  const withThumb = { ...data, thumbnail: captureThumbnail() ?? data.thumbnail }
  const payload = JSON.stringify(withThumb, null, 2)
  const blob    = new Blob([payload], { type: 'application/json' })
  const url     = URL.createObjectURL(blob)
  const a       = document.createElement('a')
  a.href        = url
  a.download    = name.trim().replace(/\s+/g, '_') + '.json'
  a.click()
  URL.revokeObjectURL(url)
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  padding: '8px 16px', borderRadius: '8px',
  fontSize: '13px', fontWeight: '500', cursor: 'pointer',
  fontFamily: 'inherit', border: 'none', transition: 'opacity 0.1s',
}

// ── Modal overlay ─────────────────────────────────────────────────────────────

function ModalOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: '14px',
          width: '340px', maxWidth: '90vw',
          boxShadow: '0 16px 48px rgba(0,0,0,0.28)',
          overflow: 'hidden', fontFamily: 'inherit',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// ── Save dialog ───────────────────────────────────────────────────────────────

interface SaveDialogProps {
  initialName: string
  onSave:      (name: string) => void
  onClose:     () => void
}

export function SaveDialog({ initialName, onSave, onClose }: SaveDialogProps) {
  const [name, setName] = useState(initialName)

  function submit() {
    const t = name.trim()
    if (t) onSave(t)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ fontSize: '15px', fontWeight: '700', color: '#1D1D1F' }}>Save Scene</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() }}
          placeholder="Scene name…"
          autoFocus
          style={{
            background: '#F2F2F7', border: '1.5px solid #D1D1D6', borderRadius: '8px',
            padding: '9px 12px', fontSize: '13px', color: '#1D1D1F', outline: 'none',
            fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...btnBase, background: '#F2F2F7', color: '#6C6C70' }}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim()}
            style={{ ...btnBase, background: '#007AFF', color: '#fff', opacity: name.trim() ? 1 : 0.4 }}
          >
            Save
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

// ── Load dialog ───────────────────────────────────────────────────────────────

interface LoadDialogProps {
  onLoad:      (save: SceneSave) => void
  onClose:     () => void
  currentName: string
  currentData: Record<string, unknown>
}

// iOS-style toggle switch.
function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title="Show all scenes (off = study scenes A · B · C)"
      style={{
        width: '28px', height: '15px', borderRadius: '8px', border: 'none', padding: 0,
        background: on ? '#007AFF' : '#E9E9EA', cursor: 'pointer',
        position: 'relative', flexShrink: 0, transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: '2px', left: on ? '15px' : '2px',
        width: '11px', height: '11px', borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.15s',
      }} />
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '8px 20px 4px', fontSize: '10px', fontWeight: '700',
      letterSpacing: '0.08em', textTransform: 'uppercase', color: '#AEAEB2',
    }}>
      {children}
    </div>
  )
}

export function LoadDialog({ onLoad, onClose, currentName, currentData }: LoadDialogProps) {
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [importText, setImportText] = useState<string | null>(null)   // non-null → import view open
  const [importErr,  setImportErr]  = useState<string>('')
  const [showAll,    setShowAll]    = useState(false)   // off (default) → only the A/B/C study scenes

  const visiblePresets = showAll ? PRESETS : PRESETS.filter(isStudyScene)

  // Load a scene from pasted JSON. Accepts a bare scene state (like a preset
  // file), a study export { data: … }, or a whole DB row { participant, data, … }.
  function loadFromJson(raw: string, name: string) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { setImportErr('That is not valid JSON.'); return }
    const asObj = (o: unknown): Record<string, unknown> | null =>
      o && typeof o === 'object' ? (o as Record<string, unknown>) : null
    const isScene = (o: Record<string, unknown> | null): boolean =>
      !!o && ('markConfig' in o || 'col1Config' in o || 'sceneConfig' in o)
    const root  = asObj(parsed)
    const inner = asObj(root?.data)                      // study export / DB row { data: … }
    const data  = isScene(root) ? root : (isScene(inner) ? inner : null)
    if (!data) { setImportErr('This JSON doesn’t look like a saved scene.'); return }
    onLoad({ id: 'import', name: name || 'Imported', createdAt: '', data })
  }

  function row(s: SceneSave, last: boolean) {
    const thumb = s.data?.thumbnail as string | undefined
    return (
      <div
        key={s.id}
        style={{
          display: 'flex', alignItems: 'center', gap: '11px',
          padding: '10px 20px', cursor: 'pointer',
          background: hoverId === s.id ? '#F8F8FA' : 'transparent',
          borderBottom: last ? 'none' : '1px solid #F2F2F7',
          transition: 'background 0.08s',
        }}
        onClick={() => onLoad(s)}
        onMouseEnter={() => setHoverId(s.id)}
        onMouseLeave={() => setHoverId(null)}
      >
        <div style={{
          width: '62px', height: '44px', flexShrink: 0,
          borderRadius: '6px', overflow: 'hidden', background: '#F2F2F7',
          border: '1px solid #E5E5EA',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {thumb
            ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : <span style={{ fontSize: '15px', color: '#C7C7CC' }}>▦</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#1D1D1F', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
          {s.createdAt && (
            <div style={{ fontSize: '10px', color: '#8E8E93', marginTop: '2px' }}>
              {new Date(s.createdAt).toLocaleString()}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #E5E5EA',
          fontSize: '15px', fontWeight: '700', color: '#1D1D1F',
        }}>
          Load Scene
        </div>

        {importText === null ? (
          <>
            {/* Scrollable list */}
            <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
              {visiblePresets.length > 0 ? (
                <>
                  <SectionLabel>Presets</SectionLabel>
                  {visiblePresets.map((s, i) => row(s, i === visiblePresets.length - 1))}
                </>
              ) : (
                <div style={{ padding: '36px 20px', textAlign: 'center', color: '#8E8E93', fontSize: '13px' }}>
                  No scenes yet
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: '12px 20px', borderTop: '1px solid #E5E5EA',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
            }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => exportScene(currentName, currentData)}
                  title="Export current scene as JSON"
                  style={{ ...btnBase, background: '#F2F2F7', color: '#007AFF', padding: '7px 12px' }}
                >
                  Export
                </button>
                <button
                  onClick={() => { setImportErr(''); setImportText('') }}
                  title="Load a scene from JSON (paste or file) — e.g. a session from Supabase"
                  style={{ ...btnBase, background: '#F2F2F7', color: '#007AFF', padding: '7px 12px' }}
                >
                  Import
                </button>
                <ToggleSwitch on={showAll} onChange={setShowAll} />
              </div>
              <button onClick={onClose} style={{ ...btnBase, background: '#F2F2F7', color: '#6C6C70' }}>
                Close
              </button>
            </div>
          </>
        ) : (
          /* Import view — paste JSON or choose a file */
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '12px', color: '#6C6C70', lineHeight: 1.4 }}>
              Paste a session’s JSON.
            </div>
            <textarea
              value={importText}
              onChange={(e) => { setImportText(e.target.value); setImportErr('') }}
              placeholder='{ "level": 2, "markConfig": { … }, … }'
              spellCheck={false}
              style={{
                width: '100%', height: '150px', resize: 'vertical', boxSizing: 'border-box',
                border: '1px solid #D1D1D6', borderRadius: '8px', padding: '8px',
                fontSize: '11px', fontFamily: 'monospace', color: '#1D1D1F', outline: 'none',
              }}
            />
            {importErr && <div style={{ fontSize: '11px', color: '#FF3B30' }}>{importErr}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => { setImportText(null); setImportErr('') }}
                style={{ ...btnBase, background: '#F2F2F7', color: '#6C6C70' }}
              >
                Cancel
              </button>
              <button
                onClick={() => loadFromJson(importText, 'Imported')}
                disabled={!importText.trim()}
                style={{ ...btnBase, background: importText.trim() ? '#007AFF' : '#C7C7CC', color: '#fff', cursor: importText.trim() ? 'pointer' : 'default' }}
              >
                Load
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalOverlay>
  )
}

// ── localStorage helpers ──────────────────────────────────────────────────────

const STORAGE_KEY = 'phys_tool_saves'

export function loadSaves(): SceneSave[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') }
  catch { return [] }
}

export function persistSaves(saves: SceneSave[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saves))
}
