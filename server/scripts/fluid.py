"""
fluid.py — Blender 4.x headless Mantaflow liquid simulation
Usage: blender --background --python fluid.py -- <output.json> <resolution> <frame_end> <viscosity>

viscosity: water | honey | lava
Prints: FLUID_BAKING, FLUID_BAKE_DONE, FLUID_PROGRESS:n/total, FLUID_DONE
"""

import bpy
import bmesh
import json
import sys
import os
import shutil
from mathutils import Vector

# ── Args ──────────────────────────────────────────────────────────────────────

argv = sys.argv
try:
    args = argv[argv.index('--') + 1:]
except ValueError:
    print("ERROR: no args after '--'"); sys.exit(1)

output_json      = args[0]
resolution       = int(args[1])   if len(args) > 1 else 24
frame_end        = int(args[2])   if len(args) > 2 else 60
viscosity        = args[3]        if len(args) > 3 else 'water'
container_path   = args[4]        if len(args) > 4 and args[4] else None
container_scale  = float(args[5]) if len(args) > 5 else 1.0
container_y      = float(args[6]) if len(args) > 6 else 0.0   # Three.js Y offset → Blender Z

print(f"[fluid] resolution={resolution}  frames={frame_end}  viscosity={viscosity}  container_scale={container_scale}  container_y={container_y}", flush=True)

VISC = {
    'water': (1, 6),
    'honey': (2, 3),
    'lava':  (1, 0),
}
visc_val, visc_exp = VISC.get(viscosity, (1, 6))

cache_dir = output_json.replace('.json', '_cache')
os.makedirs(cache_dir, exist_ok=True)

# ── Helper: add fluid modifier via data API (avoids Blender 4.x operator enum bug) ──

def add_fluid(obj, fluid_type):
    """Add Mantaflow fluid modifier to obj and return it. fluid_type: DOMAIN | FLOW | EFFECTOR"""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new(name='Fluid', type='FLUID')
    if mod is None:
        print(f"ERROR: could not add FLUID modifier to {obj.name} (type={obj.type})", flush=True)
        sys.exit(1)
    mod.fluid_type = fluid_type
    return mod

# ── Clear scene ───────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

scene = bpy.context.scene
scene.frame_start = 1
scene.frame_end   = frame_end

# ── Domain ────────────────────────────────────────────────────────────────────

bpy.ops.mesh.primitive_cube_add(size=4.0, location=(0, 0, 0))
domain = bpy.context.active_object
domain.name = 'FluidDomain'

fluid_mod = add_fluid(domain, 'DOMAIN')
ds = fluid_mod.domain_settings
ds.domain_type         = 'LIQUID'
ds.resolution_max      = resolution
ds.use_adaptive_domain = False
ds.cache_directory     = cache_dir
ds.cache_type          = 'MODULAR'

if viscosity in ('honey', 'lava'):
    ds.use_viscosity      = True
    ds.viscosity_value    = visc_val
    ds.viscosity_exponent = visc_exp

print(f"[fluid] domain ready  cache={cache_dir}", flush=True)

# ── Inflow ────────────────────────────────────────────────────────────────────
# Sphere emitter near the top of the domain. No initial velocity — Blender's
# default gravity (-Z) pulls the fluid straight down.

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.3, location=(0.0, 0.0, 1.4))
inflow = bpy.context.active_object
inflow.name = 'Inflow'

inflow_mod = add_fluid(inflow, 'FLOW')
fs = inflow_mod.flow_settings
fs.flow_type     = 'LIQUID'
fs.flow_behavior = 'INFLOW'

print(f"[fluid] inflow ready", flush=True)

# ── Optional container ────────────────────────────────────────────────────────
# Imported as a Mantaflow EFFECTOR/COLLISION so fluid fills the bowl shape.
# Normalised to 1.5 units, centred in XY, seated in the lower half of the domain.
# A Solidify modifier gives thin-shell meshes the wall thickness Mantaflow needs.

if container_path and os.path.exists(container_path):
    before = {o.name for o in scene.objects}
    bpy.ops.import_scene.gltf(filepath=container_path)

    imported = [o for o in scene.objects if o.name not in before and o.type == 'MESH']
    if not imported:
        print('WARNING: no mesh in container GLB — skipping', flush=True)
    else:
        bpy.ops.object.select_all(action='DESELECT')
        for o in imported:
            o.select_set(True)
        bpy.context.view_layer.objects.active = imported[0]
        if len(imported) > 1:
            bpy.ops.object.join()

        cont = bpy.context.active_object
        cont.name = 'Container'

        # Bake any parent offsets into mesh coords
        if cont.parent:
            bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

        # Normalise: fit to ~2.8 units × user scale so the cavity spans many voxels
        # (a small container's interior collapses under the solidified walls).
        # Then seat the BOTTOM just above the domain floor so the opening faces up
        # under the inflow. container_y is Three.js Y (= Blender Z) — an extra lift.
        bbox    = [cont.matrix_world @ Vector(c) for c in cont.bound_box]
        xs      = [v.x for v in bbox]; ys = [v.y for v in bbox]; zs = [v.z for v in bbox]
        max_dim = max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs), 0.001)
        cont.scale = (2.8 / max_dim * container_scale,) * 3
        bpy.ops.object.transform_apply(scale=True)
        # Recompute the scaled height, then seat the bottom at z = -1.9 (+ user Y).
        bbox2  = [cont.matrix_world @ Vector(c) for c in cont.bound_box]
        zs2    = [v.z for v in bbox2]
        half_h = (max(zs2) - min(zs2)) / 2.0
        bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
        cont.location = (0, 0, -1.9 + half_h + container_y)
        bpy.ops.object.transform_apply(location=True)

        # Recalculate normals consistently outward so Mantaflow sees a clean surface
        bpy.context.view_layer.objects.active = cont
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode='OBJECT')

        # Solidify walls just enough for the collision grid to see them (~1.5 voxels),
        # thin so they don't eat the interior cavity the fluid needs to fill.
        # Domain = 4 units; voxel = 4 / resolution.
        voxel = 4.0 / resolution
        solid = cont.modifiers.new('Solidify', type='SOLIDIFY')
        solid.thickness = max(0.05, voxel * 1.5)
        solid.offset    = 1.0   # thicken outward (normals point out), keeping the cavity intact
        bpy.ops.object.modifier_apply(modifier=solid.name)

        cont_mod = add_fluid(cont, 'EFFECTOR')
        cont_mod.effector_settings.effector_type = 'COLLISION'
        print(f'[fluid] container ready  verts={len(cont.data.vertices)}', flush=True)
else:
    if container_path:
        print(f'WARNING: container path not found: {container_path}', flush=True)

# ── Bake ──────────────────────────────────────────────────────────────────────

print("FLUID_BAKING", flush=True)
bpy.context.view_layer.objects.active = domain
bpy.context.view_layer.update()

try:
    with bpy.context.temp_override(active_object=domain):
        result = bpy.ops.fluid.bake_all()
    print(f"[fluid] bake result: {result}", flush=True)
    if 'FINISHED' not in result:
        print(f"ERROR: bake returned {result}", flush=True)
        sys.exit(1)
except RuntimeError as e:
    print(f"ERROR: bpy.ops.fluid.bake_all() raised RuntimeError: {e}", flush=True)
    sys.exit(1)

print("FLUID_BAKE_DONE", flush=True)

# ── Export frames ─────────────────────────────────────────────────────────────

depsgraph = bpy.context.evaluated_depsgraph_get()
all_frames = []

for i, frame in enumerate(range(1, frame_end + 1)):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    depsgraph.update()

    eval_domain = domain.evaluated_get(depsgraph)
    mesh = eval_domain.to_mesh()

    if mesh is None or len(mesh.vertices) == 0:
        all_frames.append({'p': [], 'i': []})
        eval_domain.to_mesh_clear()
        print(f"FLUID_PROGRESS:{i+1}/{frame_end}", flush=True)
        continue

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()

    # Blender is Z-up; Three.js is Y-up. Remap: Three(x,y,z) = Blender(x, z, -y)
    positions = [round(c, 3) for v in mesh.vertices for c in (v.co.x, v.co.z, -v.co.y)]
    indices   = [vi for poly in mesh.polygons if len(poly.vertices) == 3 for vi in poly.vertices]

    all_frames.append({'p': positions, 'i': indices})
    eval_domain.to_mesh_clear()
    print(f"FLUID_PROGRESS:{i+1}/{frame_end}", flush=True)

# ── Write output ──────────────────────────────────────────────────────────────

result = {
    'frameCount': len(all_frames),
    'fps':        24,
    'viscosity':  viscosity,
    'frames':     all_frames,
}

with open(output_json, 'w') as f:
    json.dump(result, f, separators=(',', ':'))

shutil.rmtree(cache_dir, ignore_errors=True)

print(f"FLUID_DONE:{output_json}", flush=True)
