"""
FRACTURE DEBUG — paste into Blender's Scripting tab and run.
Window > Toggle System Console  to see all print() output.

Adjust the CONFIG section, hit Run Script, and watch the 3D viewport + console.
"""

import bpy
import bmesh
import mathutils
import random
import math

# ── CONFIG — edit these ───────────────────────────────────────────────────────

SHAPE      = 'sphere'   # 'sphere', 'cube', or 'file'
INPUT_GLB  = r"C:\Users\spili\Desktop\cigarette.glb"   # only used when SHAPE = 'file'
OUTPUT_GLB = r"C:\Users\spili\Desktop\shattered_test.glb"
N_PIECES   = 20
VOXEL_DIV  = 30   # try 20, 30, 40

# ─────────────────────────────────────────────────────────────────────────────

N_CUTS = N_PIECES - 1
print(f"\n{'='*60}")
print(f"TARGET {N_PIECES} pieces  |  {N_CUTS} cuts  |  {VOXEL_DIV} voxel divisions")
print(f"{'='*60}\n")

# ── 1. Create or load source mesh ────────────────────────────────────────────

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

if SHAPE == 'sphere':
    print("Creating UV sphere...")
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=64, ring_count=32)
    source = bpy.context.active_object

elif SHAPE == 'cube':
    print("Creating cube...")
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    source = bpy.context.active_object

elif SHAPE == 'file':
    print(f"Importing {INPUT_GLB}...")
    bpy.ops.import_scene.gltf(filepath=INPUT_GLB)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError("No meshes found in file.")
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    source = bpy.context.active_object

else:
    raise RuntimeError(f"Unknown SHAPE '{SHAPE}'. Use 'sphere', 'cube', or 'file'.")

source.name = 'Source'
print(f"\nSource after join: {len(source.data.vertices)} verts, {len(source.data.polygons)} faces")

# ── 3. Normalise scale to 2 Blender units ────────────────────────────────────

bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bbox = [source.matrix_world @ mathutils.Vector(c) for c in source.bound_box]
xs = [v.x for v in bbox]; ys = [v.y for v in bbox]; zs = [v.z for v in bbox]
max_dim = max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs), 0.001)
norm_scale = 2.0 / max_dim
source.scale = (norm_scale, norm_scale, norm_scale)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
source.location = (0, 0, 0)
bpy.ops.object.transform_apply(location=True)
print(f"Normalised to 2 units (was {max_dim:.3f} units, scale factor {norm_scale:.4f})")

# ── 4. Voxel remesh ───────────────────────────────────────────────────────────
# This is the key step — turns the mesh into a solid watertight volume
# so cuts go through geometry rather than just splitting existing islands.

voxel_size = 2.0 / VOXEL_DIV
print(f"\nApplying voxel remesh (voxel_size={voxel_size:.4f})...")

mod = source.modifiers.new('Remesh', type='REMESH')
mod.mode = 'VOXEL'
mod.voxel_size = voxel_size
mod.use_smooth_shade = False
bpy.ops.object.modifier_apply(modifier=mod.name)
print(f"After remesh: {len(source.data.vertices)} verts, {len(source.data.polygons)} faces")

if len(source.data.vertices) < 20:
    print("WARNING: Very few vertices after remesh — the model may be too thin or the voxel size too large.")
    print("Try increasing VOXEL_DIV to 40 or 50.")

# ── 5. Bisect cuts ────────────────────────────────────────────────────────────

print(f"\nApplying {N_CUTS} random bisect cuts...")
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(source.data)

vco     = [v.co.copy() for v in bm.verts]
center  = sum(vco, mathutils.Vector()) / len(vco)
min_co  = mathutils.Vector((min(v.x for v in vco), min(v.y for v in vco), min(v.z for v in vco)))
max_co  = mathutils.Vector((max(v.x for v in vco), max(v.y for v in vco), max(v.z for v in vco)))
extents = max_co - min_co

fill_fails = 0
for i in range(N_CUTS):
    phi    = random.uniform(0, 2 * math.pi)
    theta  = random.uniform(0, math.pi)
    normal = mathutils.Vector((math.sin(theta)*math.cos(phi), math.sin(theta)*math.sin(phi), math.cos(theta))).normalized()
    plane_co = mathutils.Vector((
        center.x + random.gauss(0, extents.x * 0.25),
        center.y + random.gauss(0, extents.y * 0.25),
        center.z + random.gauss(0, extents.z * 0.25),
    ))

    res = bmesh.ops.bisect_plane(
        bm,
        geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
        plane_co=plane_co,
        plane_no=normal,
        clear_inner=False,
        clear_outer=False,
    )

    cut_edges = [e for e in res.get('geom_cut', []) if isinstance(e, bmesh.types.BMEdge)]
    if cut_edges:
        try:
            bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=True, edges=cut_edges)
        except Exception as e:
            fill_fails += 1
            # don't print each one — just count

print(f"Cuts complete. Fill failures: {fill_fails}/{N_CUTS}")
print(f"Mesh now: {len(bm.verts)} verts, {len(bm.faces)} faces")

bmesh.update_edit_mesh(source.data)

bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.fill_holes(sides=0)
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')

# ── 6. Separate loose parts ───────────────────────────────────────────────────

print("\nSeparating loose parts...")
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='LOOSE')
bpy.ops.object.mode_set(mode='OBJECT')

fragments = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print(f"\nRESULT: {len(fragments)} fragments")

if len(fragments) <= 1:
    print("\nPROBLEM: Only 1 fragment — the cuts aren't disconnecting the mesh.")
    print("Possible causes:")
    print("  - triangle_fill is patching the cuts so pieces stay connected")
    print("  - voxel remesh produced a non-manifold mesh")
    print("  - bisect planes are all parallel or outside the mesh")
    print("Try: increase VOXEL_DIV, or set N_CUTS higher")
else:
    sizes = sorted([len(f.data.vertices) for f in fragments], reverse=True)
    print(f"Fragment sizes (verts): {sizes[:10]}{'...' if len(sizes)>10 else ''}")

# ── 7. Export ─────────────────────────────────────────────────────────────────

if OUTPUT_GLB and len(fragments) > 1:
    bpy.ops.object.select_all(action='DESELECT')
    for f in fragments:
        f.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=OUTPUT_GLB,
        export_format='GLB',
        use_selection=True,
        export_animations=False,
    )
    print(f"\nExported to: {OUTPUT_GLB}")
else:
    print("\nSkipping export (no OUTPUT_GLB set or only 1 fragment).")

print("\nDone. Check the 3D viewport and the console output above for diagnostics.")
