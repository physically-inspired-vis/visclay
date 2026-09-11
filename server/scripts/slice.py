"""
slice.py  —  Blender 4.x headless: cut a mesh into N individual segments.

UI-axis → Blender-axis mapping
-------------------------------
  UI X  →  Blender X  (Three.js X, horizontal)
  UI Y  →  Blender Z  (Three.js Y, vertical / up)
  UI Z  →  Blender Y  (Three.js Z, depth)

Blender is Z-up; Three.js / GLTF is Y-up.  The exporter maps Blender-Z →
GLTF-Y, so "Y" in the UI (the vertical scene axis) must cut along Blender-Z.

Normalisation strategy
-----------------------
All bounds are computed from VERTEX DATA, never from object.bound_box.
bound_box is a cached value that can be stale after transform_apply, causing
the cap positions to be in a different coordinate frame from the segment
geometry — which is what produces the "floating caps" bug.

For imported GLBs, each mesh object's parent transform is cleared and its
full world transform is baked BEFORE joining, so all geometry lives in a
consistent world-space coordinate system.

Layout
------
Segments keep their NATURAL positions along the cut axis and are separated
only by a small fixed gap, giving an exploded-view "segmented object" look.

Prints SLICE_DONE:<path> on success.
"""

import bpy, bmesh, math, json, sys, os
from mathutils import Vector

# ── args ─────────────────────────────────────────────────────────────────────

argv = sys.argv
args = argv[argv.index('--') + 1:]

output_path    = args[0]
cut_boundaries = json.loads(args[1])
axis_ui        = args[2].upper()
cut_color_hex  = args[3]
input_path     = args[4] if len(args) > 4 else 'SPHERE'
texture_path   = args[5] if len(args) > 5 else None
texture_tiling = float(args[6]) if len(args) > 6 else 1.0

n_segments = len(cut_boundaries) - 1

# UI Y (Three.js vertical) → Blender Z (index 2)
# UI Z (Three.js depth)    → Blender Y (index 1)
# UI X                     → Blender X (index 0)
AXIS_MAP = {'X': 0, 'Y': 2, 'Z': 1}
axis_idx = AXIS_MAP.get(axis_ui, 2)

print(f'[slice] {n_segments} segs  ui={axis_ui}→blender_idx={axis_idx}  '
      f'color={cut_color_hex}  input={input_path}', flush=True)

# ── helpers ───────────────────────────────────────────────────────────────────

def hex_rgba(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)


def edge_groups(edges):
    remaining = set(edges)
    groups = []
    while remaining:
        start = next(iter(remaining))
        group, stack = [], [start]
        while stack:
            e = stack.pop()
            if e in remaining:
                remaining.discard(e)
                group.append(e)
                for v in e.verts:
                    stack.extend(oe for oe in v.link_edges if oe in remaining)
        groups.append(group)
    return groups


def order_edge_loop(edges):
    """Walk a closed edge loop and return its vertices in traversal order."""
    if not edges:
        return []
    adj = {}   # vertex id → (vertex, [neighbour_verts])
    for e in edges:
        v0, v1 = e.verts[0], e.verts[1]
        if id(v0) not in adj:
            adj[id(v0)] = (v0, [])
        if id(v1) not in adj:
            adj[id(v1)] = (v1, [])
        adj[id(v0)][1].append(v1)
        adj[id(v1)][1].append(v0)

    start_v  = next(iter(adj.values()))[0]
    ordered  = [start_v]
    prev_v   = None
    while len(ordered) < len(adj):
        curr_v    = ordered[-1]
        neighbors = adj[id(curr_v)][1]
        next_v    = next((v for v in neighbors if v is not prev_v), None)
        if next_v is None or next_v is start_v:
            break
        ordered.append(next_v)
        prev_v = curr_v
    return ordered


def fill_loop(cap, grp, perp):
    """
    Fill a closed edge loop using three strategies in order of quality:

    1. triangle_fill  — best quality, proper mesh topology
    2. N-gon          — exact shape, clean rendering; GLTF exporter
                        triangulates it correctly via ear-clipping
    3. centroid fan   — always fills but may show seams for concave shapes
    """
    # ── strategy 1: triangle_fill ────────────────────────────────────────
    try:
        fr     = bmesh.ops.triangle_fill(cap, use_beauty=True, edges=grp)
        gfaces = [g for g in fr.get('geom', []) if isinstance(g, bmesh.types.BMFace)]
        if gfaces:
            return gfaces
    except Exception:
        pass

    # ── strategy 2: ordered N-gon ────────────────────────────────────────
    # Walk the edge loop to get vertices in order, then create a single
    # n-gon.  Blender handles n-gons natively; the exporter ear-clips them.
    try:
        ordered = order_edge_loop(grp)
        if len(ordered) >= 3:
            f = cap.faces.new(ordered)
            if f:
                return [f]
    except Exception:
        pass

    # ── strategy 3: centroid fan ─────────────────────────────────────────
    verts = list({v for e in grp for v in e.verts})
    if len(verts) < 3:
        return []
    co = sum((v.co for v in verts), Vector((0.0, 0.0, 0.0))) / len(verts)
    cv = cap.verts.new(co)
    cap.verts.ensure_lookup_table()
    cx, cy = co[perp[0]], co[perp[1]]
    verts.sort(key=lambda v: math.atan2(v.co[perp[1]] - cy, v.co[perp[0]] - cx))
    faces = []
    for j in range(len(verts)):
        v0, v1 = verts[j], verts[(j + 1) % len(verts)]
        try:
            faces.append(cap.faces.new([v0, v1, cv]))
        except Exception:
            pass
    return faces


def mesh_vertex_bbox(mesh_data):
    """Return (box_min, box_max, centre, dims) from vertex data.
    Never uses object.bound_box, which can be stale after transform_apply."""
    bm = bmesh.new()
    bm.from_mesh(mesh_data)
    if not bm.verts:
        bm.free()
        return None
    vco     = [v.co.copy() for v in bm.verts]
    bm.free()
    box_min = [min(c[d] for c in vco) for d in range(3)]
    box_max = [max(c[d] for c in vco) for d in range(3)]
    dims    = [box_max[d] - box_min[d] for d in range(3)]
    centre  = Vector([(box_min[d] + box_max[d]) / 2 for d in range(3)])
    return box_min, box_max, centre, dims


def make_cap(src_data, axis_idx, cut_z, cut_mat, perp):
    """
    Flat cap at cut_z from source data.  Uses geom_cut (always coplanar,
    clean loops) and fills with triangle_fill + centroid-fan fallback.
    """
    bm = bmesh.new()
    bm.from_mesh(src_data)

    plane_no           = Vector([1.0 if j == axis_idx else 0.0 for j in range(3)])
    plane_co           = Vector([0.0, 0.0, 0.0])
    plane_co[axis_idx] = cut_z

    res = bmesh.ops.bisect_plane(
        bm,
        geom        = bm.verts[:] + bm.edges[:] + bm.faces[:],
        dist        = 0.0001,
        plane_co    = plane_co,
        plane_no    = plane_no,
        clear_outer = False,
        clear_inner = False,
    )

    cut_verts = [g for g in res.get('geom_cut', []) if isinstance(g, bmesh.types.BMVert)]
    cut_edges = [g for g in res.get('geom_cut', []) if isinstance(g, bmesh.types.BMEdge)]

    if not cut_verts:
        bm.free()
        return None

    # Build isolated cap bmesh while source bm is still alive (cut_verts reference it)
    cap  = bmesh.new()
    vmap = {}
    for v in cut_verts:
        nv          = cap.verts.new(v.co.copy())
        vmap[id(v)] = nv
    cap.verts.ensure_lookup_table()
    for e in cut_edges:
        nv0, nv1 = vmap.get(id(e.verts[0])), vmap.get(id(e.verts[1]))
        if nv0 and nv1:
            try:
                cap.edges.new([nv0, nv1])
            except Exception:
                pass
    bm.free()

    # Merge coincident cap vertices.  UV-seam-duplicated verts in the source
    # mesh produce two coincident edges (one per UV island) in geom_cut.
    # Without merging, edge_groups sees a thin degenerate "seam loop" in
    # addition to the real cross-section loop; filling both creates a phantom
    # rectangular face that shows as a gap inside the cap.
    bmesh.ops.remove_doubles(cap, verts=cap.verts[:], dist=0.0002)

    cap.edges.ensure_lookup_table()
    fill_faces = []
    for grp in edge_groups(cap.edges[:]):
        fill_faces.extend(fill_loop(cap, grp, perp))

    if not fill_faces:
        cap.free()
        return None

    # Planar UV projection
    all_co = [v.co for f in fill_faces for v in f.verts]
    u0  = min(c[perp[0]] for c in all_co); u1  = max(c[perp[0]] for c in all_co)
    v0  = min(c[perp[1]] for c in all_co); v1  = max(c[perp[1]] for c in all_co)
    ur  = max(u1 - u0, 0.0001);            vr  = max(v1 - v0, 0.0001)
    uvl = cap.loops.layers.uv.new('CutUV')
    for f in fill_faces:
        for lp in f.loops:
            c = lp.vert.co
            lp[uvl].uv = ((c[perp[0]] - u0) / ur, (c[perp[1]] - v0) / vr)

    bmesh.ops.recalc_face_normals(cap, faces=cap.faces[:])
    mesh = bpy.data.meshes.new('Cap')
    cap.to_mesh(mesh)
    cap.free()
    mesh.materials.append(cut_mat)
    obj = bpy.data.objects.new('Cap', mesh)
    bpy.context.collection.objects.link(obj)
    return obj

# ── clear scene ───────────────────────────────────────────────────────────────

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# ── load / create source ──────────────────────────────────────────────────────

if input_path == 'SPHERE':
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=64, ring_count=32)
    bpy.ops.object.shade_smooth()
elif input_path == 'CUBE':
    bpy.ops.mesh.primitive_cube_add(size=2)
    mod = bpy.context.object.modifiers.new('Sub', 'SUBSURF')
    mod.levels = 2
    bpy.ops.object.modifier_apply(modifier='Sub')
    bpy.ops.object.shade_smooth()
else:
    before = {o.name for o in bpy.context.scene.objects}
    bpy.ops.import_scene.gltf(filepath=input_path)
    meshes = [o for o in bpy.context.scene.objects
              if o.name not in before and o.type == 'MESH']
    if not meshes:
        print('ERROR: no mesh objects in input', flush=True)
        sys.exit(1)

    # ── Critical: bake EVERY mesh's full world transform before joining ──
    # GLB imports often include parent empties/armatures whose transforms
    # are inherited but not stored in the mesh itself.  Without clearing
    # parents first, transform_apply only applies the LOCAL transform,
    # leaving the parent offset unaccounted for.  This is what causes caps
    # to appear in a completely different position from the segments.
    for o in meshes:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        if o.parent is not None:
            bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()

source = bpy.context.active_object
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.context.view_layer.update()

# ── normalise to 2-unit bbox centred at origin (vertex-based, no bound_box) ──
# object.bound_box is a cached value that can be stale after transform_apply.
# Reading directly from vertex coordinates is always accurate.

result = mesh_vertex_bbox(source.data)
if result is None:
    print('ERROR: source mesh has no vertices', flush=True)
    sys.exit(1)
_, _, centre, dims = result

scale_val = 2.0 / max(max(dims), 0.0001)
source.scale = (scale_val, scale_val, scale_val)
bpy.ops.object.transform_apply(scale=True)

# After baking the scale, recompute centre (it scaled too)
_, _, centre_scaled, _ = mesh_vertex_bbox(source.data)
source.location = -centre_scaled
bpy.ops.object.transform_apply(location=True)

bpy.context.view_layer.update()
print('[slice] source normalised (vertex bbox)', flush=True)

# ── axis bounds from vertex data (consistent with source.data) ────────────────

bm_src = bmesh.new()
bm_src.from_mesh(source.data)
ax_min  = min(v.co[axis_idx] for v in bm_src.verts)
ax_max  = max(v.co[axis_idx] for v in bm_src.verts)
bm_src.free()
ax_span = max(ax_max - ax_min, 0.0001)

print(f'[slice] axis={axis_idx}  ax_min={ax_min:.3f}  ax_max={ax_max:.3f}', flush=True)

# ── cut-face material ─────────────────────────────────────────────────────────

cut_mat           = bpy.data.materials.new('CutFace')
cut_mat.use_nodes = True
nt   = cut_mat.node_tree
bsdf = nt.nodes['Principled BSDF']

if texture_path and os.path.exists(texture_path):
    img = bpy.data.images.load(texture_path)
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
    uvm = nt.nodes.new('ShaderNodeUVMap');   uvm.uv_map = 'CutUV'
    mapp = nt.nodes.new('ShaderNodeMapping')
    mapp.inputs['Scale'].default_value = (texture_tiling, texture_tiling, texture_tiling)
    nt.links.new(uvm.outputs['UV'],       mapp.inputs['Vector'])
    nt.links.new(mapp.outputs['Vector'],  tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'],    bsdf.inputs['Base Color'])
else:
    bsdf.inputs['Base Color'].default_value = hex_rgba(cut_color_hex)
    bsdf.inputs['Roughness'].default_value  = 0.65

# ── axis config ───────────────────────────────────────────────────────────────

plane_up = Vector([1.0 if j == axis_idx else 0.0 for j in range(3)])
plane_dn = -plane_up
perp     = [j for j in range(3) if j != axis_idx]

half = (n_segments - 1) / 2.0
GAP  = 0.15   # gap between segments in Blender units (normalised object ≈ 2 units)

# ── main segment loop ─────────────────────────────────────────────────────────

for i in range(n_segments):
    is_first = (i == 0)
    is_last  = (i == n_segments - 1)

    low_norm  = max(0.001, min(0.999, float(cut_boundaries[i])))
    high_norm = max(0.001, min(0.999, float(cut_boundaries[i + 1])))
    cut_low   = ax_min + low_norm  * ax_span
    cut_high  = ax_min + high_norm * ax_span

    # ── 1. bisect(s) to isolate the band ─────────────────────────────────
    # First segment: skip the lower bisect so the natural mesh surface
    # is preserved at the outer end (no flat cap cut).
    # Last segment:  skip the upper bisect for the same reason.

    dup      = source.copy()
    dup.data = source.data.copy()
    bpy.context.collection.objects.link(dup)
    bpy.context.view_layer.objects.active = dup

    bm = bmesh.new()
    bm.from_mesh(dup.data)

    if not is_last:
        co_hi = Vector([0.0, 0.0, 0.0]); co_hi[axis_idx] = cut_high
        bmesh.ops.bisect_plane(bm,
            geom=bm.verts[:]+bm.edges[:]+bm.faces[:], dist=0.0001,
            plane_co=co_hi, plane_no=plane_up, clear_outer=True, clear_inner=False)

    if not is_first:
        bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table(); bm.faces.ensure_lookup_table()
        co_lo = Vector([0.0, 0.0, 0.0]); co_lo[axis_idx] = cut_low
        bmesh.ops.bisect_plane(bm,
            geom=bm.verts[:]+bm.edges[:]+bm.faces[:], dist=0.0001,
            plane_co=co_lo, plane_no=plane_dn, clear_outer=True, clear_inner=False)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(dup.data); bm.free(); dup.data.update()

    # ── 2. flat caps — only at interior cut boundaries ────────────────────
    # The outer boundary of the first and last segments is the natural mesh
    # surface, so no cap is added there.

    cap_lo = None if is_first else make_cap(source.data, axis_idx, cut_low,  cut_mat, perp)
    cap_hi = None if is_last  else make_cap(source.data, axis_idx, cut_high, cut_mat, perp)

    print(f'[slice] seg {i+1}/{n_segments}  [{low_norm:.2f}–{high_norm:.2f}]  '
          f'lo={cap_lo is not None}  hi={cap_hi is not None}', flush=True)

    # ── 3. join caps + band ───────────────────────────────────────────────

    parts = [dup] + [c for c in (cap_lo, cap_hi) if c]
    if len(parts) > 1:
        bpy.ops.object.select_all(action='DESELECT')
        for p in parts: p.select_set(True)
        bpy.context.view_layer.objects.active = dup
        bpy.ops.object.join()

    # Weld cap boundary to band boundary
    final = bmesh.new()
    final.from_mesh(dup.data)
    bmesh.ops.remove_doubles(final, verts=final.verts[:], dist=0.0002)
    final.to_mesh(dup.data); final.free(); dup.data.update()

    # ── 4. small gap offset (natural positions preserved) ─────────────────

    dup.location[axis_idx] = (i - half) * GAP

bpy.data.objects.remove(source, do_unlink=True)

# ── export ────────────────────────────────────────────────────────────────────

bpy.ops.export_scene.gltf(
    filepath      = output_path,
    export_format = 'GLB',
    use_selection = False,
)

print(f'SLICE_DONE:{output_path}', flush=True)
