"""
deform.py  —  Blender 4.x headless deformation
Applies a Simple Deform modifier and exports the result with a shape key
so Three.js can animate between undeformed (0) and deformed (1) states.
Usage: blender --background --python deform.py -- <input|SPHERE|CUBE> <output.glb> [mode] [factor] [axis] [limitMin] [limitMax]
"""

import bpy
import bmesh
import mathutils
import sys

# ── Args ──────────────────────────────────────────────────────────────────────

argv = sys.argv
try:
    args = argv[argv.index('--') + 1:]
except ValueError:
    print("ERROR: no args after '--'"); sys.exit(1)

input_path  = args[0]
output_path = args[1]
deform_mode = args[2].upper()   if len(args) > 2 else 'STRETCH'
factor      = float(args[3])    if len(args) > 3 else 1.0
axis        = args[4].upper()   if len(args) > 4 else 'Y'
limit_min   = float(args[5])    if len(args) > 5 else 0.0
limit_max   = float(args[6])    if len(args) > 6 else 1.0
factor2     = float(args[7])    if len(args) > 7 else 0.5
bend_pivot  = float(args[8])    if len(args) > 8 else 0.0        # pivot offset along deform axis
subdivs     = int(args[9])      if len(args) > 9 else 0           # edge subdivisions for smooth bending

print(f"[deform] mode={deform_mode} factor={factor} factor2={factor2} axis={axis} pivot={bend_pivot} subdivs={subdivs} limits=[{limit_min},{limit_max}]")

# ── Clear scene ───────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# ── Create or import source ───────────────────────────────────────────────────

if input_path == 'SPHERE':
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=48, ring_count=32)
    bpy.ops.object.shade_smooth()
elif input_path == 'CUBE':
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    # Subdivide cube so deformation has enough geometry
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.subdivide(number_cuts=6)
    bpy.ops.object.mode_set(mode='OBJECT')
else:
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        print("ERROR: no meshes in GLB"); sys.exit(1)
    # Bake each mesh's full world transform before joining.
    # GLB imports often carry parent empties/armatures; without clearing
    # parents first, transform_apply only touches the local offset and
    # leaves the parent contribution in the matrix — causing the geometry
    # to appear off-centre after the bounds-centering step below.
    for m in meshes:
        bpy.ops.object.select_all(action='DESELECT')
        m.select_set(True)
        bpy.context.view_layer.objects.active = m
        if m.parent is not None:
            bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes: m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()

source = bpy.context.active_object
source.name = 'Source'

# Normalise to 2 units, centred
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bbox    = [source.matrix_world @ mathutils.Vector(c) for c in source.bound_box]
xs      = [v.x for v in bbox]; ys = [v.y for v in bbox]; zs = [v.z for v in bbox]
max_dim = max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs), 0.001)
source.scale = (2/max_dim,)*3
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
source.location = (0, 0, 0)
bpy.ops.object.transform_apply(location=True)

print(f"[deform] Source: {len(source.data.vertices)} verts")

# ── Optional subdivision (adds edge loops for smooth bending) ────────────────
# Uses Simple (linear) subdivision — preserves shape, just densifies geometry.

if subdivs > 0:
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.subdivide(number_cuts=subdivs, smoothness=0)
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f"[deform] After {subdivs}-cut subdivide: {len(source.data.vertices)} verts")

# ── Apply deformation ─────────────────────────────────────────────────────────

bpy.context.view_layer.objects.active = source

if deform_mode == 'TWIST_STRETCH':
    # Duplicate BEFORE adding shape keys so the copy is clean (no inherited keys).
    # Applying a modifier to an object that has shape keys behaves unexpectedly.
    bpy.ops.object.select_all(action='DESELECT')
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.duplicate()
    deformed_copy = bpy.context.active_object

    # Apply TWIST then STRETCH to the clean copy
    for method, fac in [('TWIST', factor), ('STRETCH', factor2)]:
        bpy.context.view_layer.objects.active = deformed_copy
        mod = deformed_copy.modifiers.new(method, type='SIMPLE_DEFORM')
        mod.deform_method = method
        mod.deform_axis   = axis
        mod.factor        = fac
        mod.limits        = (limit_min, limit_max)
        bpy.ops.object.modifier_apply(modifier=mod.name)

    n_src = len(source.data.vertices)
    n_def = len(deformed_copy.data.vertices)
    print(f"[deform] vertex counts — source: {n_src}  deformed copy: {n_def}")

    # Add Basis shape key to source (captures original positions)
    bpy.context.view_layer.objects.active = source
    source.shape_key_add(name='Basis', from_mix=False)

    # Add Deformed shape key and manually copy vertex positions from the copy.
    # Avoids join_shapes which can fail when vertex counts diverge after modifier stack.
    deformed_sk = source.shape_key_add(name='Deformed', from_mix=False)
    if n_src == n_def:
        for i, v in enumerate(deformed_copy.data.vertices):
            deformed_sk.data[i].co = v.co.copy()
        print("[deform] Deformed shape key written from copy vertices")
    else:
        print(f"ERROR: vertex count mismatch ({n_src} vs {n_def}) — Deformed key will be flat")

    # Remove the temporary copy
    bpy.data.objects.remove(deformed_copy)

elif deform_mode == 'INFLATE':
    # Move every vertex along its own surface normal.
    # Works directly on shape key data — no modifier or duplicate needed.
    source.shape_key_add(name='Basis', from_mix=False)
    deformed_sk = source.shape_key_add(name='Deformed', from_mix=False)

    bm = bmesh.new()
    bm.from_mesh(source.data)
    bm.normal_update()

    for v in bm.verts:
        deformed_sk.data[v.index].co = v.co + v.normal * factor

    bm.free()
    print(f"[deform] Inflate: {len(source.data.vertices)} verts displaced by {factor:.3f}")

else:
    # Robust path: apply modifier to a clean duplicate, then copy vertex positions
    # into a shape key on the source.  modifier_apply_as_shapekey can silently
    # ignore the limits property in Blender 4.4, so we use modifier_apply instead.
    bpy.ops.object.select_all(action='DESELECT')
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.duplicate()
    deformed_copy = bpy.context.active_object

    # For BEND: place a pivot empty on the copy before adding the modifier
    pivot_obj = None
    if deform_mode == 'BEND' and abs(bend_pivot) > 1e-4:
        loc = {'X': (bend_pivot, 0, 0), 'Y': (0, bend_pivot, 0), 'Z': (0, 0, bend_pivot)}[axis]
        bpy.ops.object.empty_add(type='PLAIN_AXES', location=loc)
        pivot_obj = bpy.context.active_object
        pivot_obj.name = 'BendPivot'
        bpy.context.view_layer.objects.active = deformed_copy
        print(f"[deform] Bend pivot at {loc}")

    mod = deformed_copy.modifiers.new('Deform', type='SIMPLE_DEFORM')
    mod.deform_method = deform_mode
    mod.deform_axis   = axis
    mod.factor        = factor
    mod.limits        = (limit_min, limit_max)
    if pivot_obj:
        mod.origin = pivot_obj

    bpy.context.view_layer.objects.active = deformed_copy
    bpy.ops.object.modifier_apply(modifier=mod.name)

    n_src = len(source.data.vertices)
    n_def = len(deformed_copy.data.vertices)
    print(f"[deform] vertex counts — source: {n_src}  deformed copy: {n_def}")

    # Shape keys on source: Basis (original) + Deformed (from copy)
    bpy.context.view_layer.objects.active = source
    source.shape_key_add(name='Basis', from_mix=False)
    deformed_sk = source.shape_key_add(name='Deformed', from_mix=False)
    if n_src == n_def:
        for i, v in enumerate(deformed_copy.data.vertices):
            deformed_sk.data[i].co = v.co.copy()
        print("[deform] Deformed shape key written from copy vertices")
    else:
        print(f"ERROR: vertex count mismatch ({n_src} vs {n_def}) — Deformed key will be flat")

    bpy.data.objects.remove(deformed_copy)
    if pivot_obj:
        bpy.data.objects.remove(pivot_obj)

print(f"[deform] Shape keys: {[sk.name for sk in source.data.shape_keys.key_blocks]}")

# ── Export ────────────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='DESELECT')
source.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    use_selection=True,
    export_animations=False,
    export_morph=True,
    export_morph_normal=True,
)

print(f"[deform] SUCCESS → {output_path}")
