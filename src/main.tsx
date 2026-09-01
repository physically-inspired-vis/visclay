import React from 'react'
import ReactDOM from 'react-dom/client'
import LabHub        from './LabHub'
import SimulationLab from './SimulationLab'
import ShatterLab    from './ShatterLab'
import DeformLab     from './DeformLab'
import ParticleLab   from './ParticleLab'
import SoftLab       from './SoftLab'
import RippleLab     from './RippleLab'
import JellyLab      from './JellyLab'
import FluidLab      from './FluidLab'
import './index.css'

const base = import.meta.env.BASE_URL.replace(/\/$/, '') // e.g. '/VisClay' or ''
const path = window.location.pathname.slice(base.length) || '/'
const root = path === '/sim'
  ? <SimulationLab />
  : path === '/shatter'
  ? <ShatterLab />
  : path === '/deform'
    ? <DeformLab />
    : path === '/particles'
      ? <ParticleLab />
      : path === '/soft'
        ? <SoftLab />
        : path === '/ripple'
          ? <RippleLab />
          : path === '/jelly'
            ? <JellyLab />
            : path === '/fluid'
              ? <FluidLab />
              : <LabHub />

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{root}</React.StrictMode>,
)
