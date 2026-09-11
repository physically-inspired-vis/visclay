"""
shatter.py  —  Blender 4.x headless fracture
Supports two methods:
  bisect  — sequential random-plane cuts (fast, good for many pieces)
  voronoi — proper Voronoi tessellation via half-plane intersection + boolean (natural looking)
Usage: blender --background --python shatter.py -- <input|SPHERE|CUBE> <output.glb> [pieces] [spread] [voxelDiv] [strategy] [adaptivity] [method]
"""

import bpy
import bmesh
import mathutils
import random
import math
import sys

# ── Args ──────────────────────────────────────────────────────────────────────

argv = sys.argv
try:
    args = argv[argv.index('--') + 1:]
except ValueError:
    print("ERROR: no args after '--'"); sys.exit(1)

input_path      = args[0]
output_path     = args[1]
n_pieces        = int(args[2])   if len(args) > 2 else 10
cut_spread      = float(args[3]) if len(args) > 3 else 0.5
voxel_div       = int(args[4])   if len(args) > 4 else 30
cut_strategy    = args[5]        if len(args) > 5 else 'random'
adaptivity      = float(args[6]) if len(args) > 6 else 0.0
fracture_method = args[7]        if len(args) > 7 else 'bisect'   # 'bisect' | 'voronoi'

print(f"[shatter] method={fracture_method} pieces={n_pieces} spread={cut_spread} strategy={cut_strategy}")

# ── Clear scene ───────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# ── Create or import source ───────────────────────────────────────────────────

if input_path == 'SPHERE':
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=32, ring_count=16)
elif input_path == 'CUBE':
    bpy.ops.mesh.primitive_cube_add(size=2.0)
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

# Normalise to 2 units, centred at origin
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bbox    = [source.matrix_world @ mathutils.Vector(c) for c in source.bound_box]
xs      = [v.x for v in bbox]; ys = [v.y for v in bbox]; zs = [v.z for v in bbox]
max_dim = max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs), 0.001)
source.scale = (2/max_dim,)*3
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
source.location = (0, 0, 0)
bpy.ops.object.transform_apply(location=True)

# Voxel remesh for file imports (makes mesh solid/manifold for clean cuts)
uv_donor = None
if input_path not in ('SPHERE', 'CUBE'):
    original_mats = list(source.data.materials)

    # Duplicate source BEFORE remesh to keep original geometry + UVs for later projection
    if source.data.uv_layers:
        bpy.ops.object.select_all(action='DESELECT')
        source.select_set(True)
        bpy.context.view_layer.objects.active = source
        bpy.ops.object.duplicate(linked=False)
        uv_donor = bpy.context.active_object
        uv_donor.name = 'UVDonor'
        uv_donor.select_set(False)
        # Restore source as active so the remesh goes onto the right object
        bpy.context.view_layer.objects.active = source
        source.select_set(True)
        print(f"[shatter] UV donor saved ({len(uv_donor.data.uv_layers)} UV layer(s))")

    mod = source.modifiers.new('Remesh', type='REMESH')
    mod.mode         = 'VOXEL'
    mod.voxel_size   = 2.0 / voxel_div
    mod.adaptivity   = max(0.0, min(1.0, adaptivity))
    mod.use_smooth_shade = False
    bpy.ops.object.modifier_apply(modifier=mod.name)

    # Restore materials (bisect duplicates inherit them; voronoi cells get assigned below)
    source.data.materials.clear()
    for mat in original_mats:
        source.data.materials.append(mat)

    print(f"[shatter] After remesh: {len(source.data.vertices)} verts, {len(original_mats)} material(s) restored")
else:
    original_mats = []

print(f"[shatter] Source ready: {len(source.data.vertices)} verts")

# ─────────────────────────────────────────────────────────────────────────────
# METHOD 1 — BISECT
# Sequential plane cuts: each cut duplicates a piece and keeps opposite halves.
# Fast. Good for large piece counts.
# ─────────────────────────────────────────────────────────────────────────────

def cut_object(obj, plane_co, plane_no):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.duplicate()
    inner = bpy.context.active_object

    for half, clear_inner, clear_outer in [(obj, True, False), (inner, False, True)]:
        bpy.context.view_layer.objects.active = half
        bpy.ops.object.mode_set(mode='EDIT')
        bm = bmesh.from_edit_mesh(half.data)
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:]+bm.edges[:]+bm.faces[:],
                               plane_co=plane_co, plane_no=plane_no,
                               clear_inner=clear_inner, clear_outer=clear_outer)
        boundary = [e for e in bm.edges if e.is_boundary]
        if boundary:
            bmesh.ops.triangle_fill(bm, edges=boundary, use_beauty=True)
        bmesh.update_edit_mesh(half.data)
        bpy.ops.object.mode_set(mode='OBJECT')

    if len(obj.data.vertices) == 0:
        bpy.data.objects.remove(obj); return inner, None
    if len(inner.data.vertices) == 0:
        bpy.data.objects.remove(inner); return obj, None
    return obj, inner


def fracture_bisect(source, n_pieces, cut_spread, cut_strategy):
    pieces = [source]
    n_cuts = n_pieces - 1
    sigma  = cut_spread * 0.5

    for i in range(n_cuts):
        target = (max(pieces, key=lambda o: len(o.data.vertices))
                  if cut_strategy == 'largest' else random.choice(pieces))
        pieces.remove(target)

        phi    = random.uniform(0, 2 * math.pi)
        theta  = random.uniform(0, math.pi)
        normal = mathutils.Vector((
            math.sin(theta) * math.cos(phi),
            math.sin(theta) * math.sin(phi),
            math.cos(theta),
        )).normalized()
        plane_co = mathutils.Vector((
            random.gauss(0, sigma),
            random.gauss(0, sigma),
            random.gauss(0, sigma),
        ))

        outer, inner = cut_object(target, plane_co, normal)
        pieces.append(outer)
        if inner: pieces.append(inner)
        print(f"  cut {i+1}/{n_cuts}: {len(pieces)} pieces")

    return pieces


# ─────────────────────────────────────────────────────────────────────────────
# METHOD 2 — VORONOI
# For each seed point, build its Voronoi cell by clipping a large cube with
# all perpendicular-bisector half-planes, then boolean-intersect with source.
# Produces natural, organic crack patterns.
# Slower than bisect (O(N²) clips + N booleans). Recommended for ≤ 50 pieces.
# ─────────────────────────────────────────────────────────────────────────────

def voronoi_cell_mesh(seed_idx, seeds, cube_size):
    """
    Build the Voronoi cell for seeds[seed_idx] as a bmesh cube clipped by
    perpendicular-bisector planes from all other seeds.

    cube_size bounds the cell: seeds on the object's boundary have Voronoi cells
    that are open (unbounded) on the outward side, so they're only limited by this
    starting cube. Keeping it just larger than the object stops those cells from
    becoming giant shards when the boolean can't fully trim them.
    """
    bpy.ops.mesh.primitive_cube_add(size=cube_size, location=(0, 0, 0))
    cell_obj = bpy.context.active_object
    cell_obj.name = f'VCell_{seed_idx}'

    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(cell_obj.data)

    seed = seeds[seed_idx]
    for j, other in enumerate(seeds):
        if j == seed_idx:
            continue
        # Perpendicular bisector plane: midpoint + normal pointing toward 'other'
        mid    = (seed + other) / 2.0
        normal = other - seed          # points away from our seed
        bmesh.ops.bisect_plane(
            bm,
            geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
            plane_co=mathutils.Vector(mid),
            plane_no=mathutils.Vector(normal),
            clear_outer=True,          # remove the half closer to 'other'
            clear_inner=False,
        )
        boundary = [e for e in bm.edges if e.is_boundary]
        if boundary:
            bmesh.ops.triangle_fill(bm, edges=boundary, use_beauty=True)

    bmesh.update_edit_mesh(cell_obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    return cell_obj


def fracture_voronoi(source, n_pieces, cut_spread, original_mats=None):
    # Generate seed points.
    # cut_spread controls distribution: 0 = clustered at centre, 1 = spread across full object.
    spread = 0.1 + cut_spread * 0.85   # map [0,1] → [0.1, 0.95]
    seeds  = [mathutils.Vector((
        random.uniform(-spread, spread),
        random.uniform(-spread, spread),
        random.uniform(-spread, spread),
    )) for _ in range(n_pieces)]

    # Object extent (normalised → ≈2). The bounding cube is kept just larger so
    # boundary cells stay tight; any fragment bigger than this is a glitch.
    sbb  = source.bound_box
    sext = max(max(v[0] for v in sbb) - min(v[0] for v in sbb),
               max(v[1] for v in sbb) - min(v[1] for v in sbb),
               max(v[2] for v in sbb) - min(v[2] for v in sbb), 0.001)
    cube_size   = sext * 1.25 + 0.1    # ≈2.6 for a 2-unit object
    max_frag_ext = sext * 1.2          # reject fragments larger than the whole object

    fragments = []
    rejected  = 0

    for i, seed in enumerate(seeds):
        print(f"  Voronoi cell {i+1}/{n_pieces}…")

        cell_obj = voronoi_cell_mesh(i, seeds, cube_size)

        if len(cell_obj.data.vertices) == 0:
            bpy.data.objects.remove(cell_obj)
            continue

        # Boolean INTERSECT: cell ∩ source  →  one fragment.
        # EXACT (not FAST): the remeshed source is manifold, and FAST leaves
        # self-intersecting spikes on the boundary cells that read as glitches.
        bool_mod            = cell_obj.modifiers.new('Bool', type='BOOLEAN')
        bool_mod.operation  = 'INTERSECT'
        bool_mod.object     = source
        bool_mod.solver     = 'EXACT'

        bpy.context.view_layer.objects.active = cell_obj
        try:
            bpy.ops.object.modifier_apply(modifier=bool_mod.name)
        except Exception as e:
            print(f"  Boolean failed for cell {i}: {e}")
            bpy.data.objects.remove(cell_obj)
            continue

        if len(cell_obj.data.vertices) > 0:
            # Safety net: drop any fragment larger than the object (a degenerate
            # cell the boolean failed to trim) so no spike survives.
            fb   = cell_obj.bound_box
            fext = max(max(v[0] for v in fb) - min(v[0] for v in fb),
                       max(v[1] for v in fb) - min(v[1] for v in fb),
                       max(v[2] for v in fb) - min(v[2] for v in fb))
            if fext > max_frag_ext:
                rejected += 1
                bpy.data.objects.remove(cell_obj)
                continue
            # Assign original material so fragments match the source appearance
            if original_mats:
                cell_obj.data.materials.clear()
                for mat in original_mats:
                    cell_obj.data.materials.append(mat)
            fragments.append(cell_obj)
        else:
            bpy.data.objects.remove(cell_obj)

    if rejected:
        print(f"[shatter] Voronoi: dropped {rejected} oversized/degenerate fragment(s)")

    # Remove the original source (cells hold the fragments now)
    bpy.data.objects.remove(source)

    print(f"[shatter] Voronoi: {len(fragments)} valid cells from {n_pieces} seeds")
    return fragments


# ── UV transfer helper ────────────────────────────────────────────────────────
# Projects UV coordinates from the pre-remesh donor mesh onto each fragment using
# nearest-polygon interpolation. Handles both bisect (remeshed topology) and
# voronoi (brand-new boolean geometry). Interior cut faces get UVs from the
# nearest original surface face — not perfect, but far better than no UVs.

def transfer_uvs(fragment, donor):
    if donor is None or not donor.data.uv_layers:
        return

    # DATA_TRANSFER silently does nothing if the target has no UV layer at all.
    # Pre-create matching empty slots so the modifier has somewhere to write into.
    existing = {l.name for l in fragment.data.uv_layers}
    for uv_layer in donor.data.uv_layers:
        if uv_layer.name not in existing:
            fragment.data.uv_layers.new(name=uv_layer.name)

    bpy.ops.object.select_all(action='DESELECT')
    fragment.select_set(True)
    bpy.context.view_layer.objects.active = fragment
    dt = fragment.modifiers.new('UVTransfer', type='DATA_TRANSFER')
    dt.object         = donor
    dt.use_loop_data  = True
    dt.data_types_loops = {'UV'}
    dt.loop_mapping   = 'POLYINTERP_NEAREST'
    try:
        bpy.ops.object.modifier_apply(modifier=dt.name)
        print(f"  UV OK: {fragment.name} ({len(fragment.data.uv_layers)} layer(s))")
    except Exception as e:
        print(f"  UV FAILED: {fragment.name}: {e}")
        try: fragment.modifiers.remove(dt)
        except Exception: pass


# ── Run ──────────────────────────────────────────────────────────────────────

mode = args[8] if len(args) > 8 else 'single'

COMPARE_PIECES = [1, 5, 15, 50]
COMPARE_X      = [-6, -2, 2, 6]

if mode == 'compare':
    all_compare = []
    for count, xpos in zip(COMPARE_PIECES, COMPARE_X):
        print(f"[shatter] compare: pieces={count} at x={xpos}")
        bpy.ops.object.select_all(action='DESELECT')
        source.select_set(True)
        bpy.context.view_layer.objects.active = source
        bpy.ops.object.duplicate(linked=False)
        src_copy = bpy.context.active_object

        if fracture_method == 'voronoi':
            frags = fracture_voronoi(src_copy, count, cut_spread, original_mats)
        else:
            frags = fracture_bisect(src_copy, count, cut_spread, cut_strategy)

        if not frags:
            print(f"  [compare] no fragments for count={count}, skipping")
            continue

        for frag in frags:
            transfer_uvs(frag, uv_donor)
            frag.location.x += xpos

        for j, frag in enumerate(frags):
            frag.name = f'g{count}_{j}'

        all_compare.extend(frags)
        print(f"  → {len(frags)} fragment(s) at x={xpos}")

    bpy.data.objects.remove(source, do_unlink=True)
    if uv_donor:
        bpy.data.objects.remove(uv_donor, do_unlink=True)
        uv_donor = None

    pieces = all_compare

else:
    if fracture_method == 'voronoi':
        pieces = fracture_voronoi(source, n_pieces, cut_spread, original_mats)
    else:
        pieces = fracture_bisect(source, n_pieces, cut_spread, cut_strategy)

    if uv_donor:
        print(f"[shatter] Projecting UVs onto {len(pieces)} fragments…")
        for piece in pieces:
            transfer_uvs(piece, uv_donor)
        bpy.data.objects.remove(uv_donor, do_unlink=True)
        uv_donor = None
        print("[shatter] UV transfer complete")

if not pieces:
    print("ERROR: no fragments produced"); sys.exit(1)

print(f"[shatter] DONE: {len(pieces)} piece(s)")

# ── Export ────────────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='DESELECT')
for p in pieces:
    p.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format='GLB',
    use_selection=True,
    export_animations=False,
    export_materials='EXPORT',
    export_texcoords=True,
    export_image_format='AUTO',
)

print(f"[shatter] SUCCESS → {output_path}")
