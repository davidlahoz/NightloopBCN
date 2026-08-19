extends SceneTree
## Print the distribution of Y levels of horizontal faces in a roads tile —
## tells us whether sidewalks are raised above the carriageway (kerb step).
## Run: godot --headless --path . --script tools/probe_tile.gd


func _init() -> void:
	var packed: PackedScene = load("res://barcelona/tiles/tile_0_0_roads.glb")
	var root: Node = packed.instantiate()
	var buckets: Dictionary = {}
	_walk(root, Transform3D.IDENTITY, buckets)
	root.free()
	var keys := buckets.keys()
	keys.sort()
	for k in keys:
		print("y=%6.2f  flat-tri area %8.0f m2" % [k, buckets[k]])
	quit()


func _walk(n: Node, xf: Transform3D, buckets: Dictionary) -> void:
	if n is Node3D:
		xf = xf * (n as Node3D).transform
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var mesh: Mesh = (n as MeshInstance3D).mesh
		for si in mesh.get_surface_count():
			var arrays := mesh.surface_get_arrays(si)
			var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			var nidx := idx.size() if idx.size() > 0 else verts.size()
			for t in range(0, nidx, 3):
				var a := xf * verts[idx[t]] if idx.size() > 0 else xf * verts[t]
				var b := xf * verts[idx[t + 1]] if idx.size() > 0 else xf * verts[t + 1]
				var c := xf * verts[idx[t + 2]] if idx.size() > 0 else xf * verts[t + 2]
				var nrm := (b - a).cross(c - a)
				if nrm.length_squared() < 1e-10:
					continue
				if absf(nrm.normalized().y) < 0.95:
					continue   # not a horizontal face
				var y := snappedf((a.y + b.y + c.y) / 3.0, 0.05)
				buckets[y] = buckets.get(y, 0.0) + nrm.length() * 0.5
	for ch in n.get_children():
		_walk(ch, xf, buckets)
