extends SceneTree
## Dump world-space triangles (x,z only) of a tile glb as CSV lines.
## godot --headless --path . --script tools/dump_verts.gd -- <res_path>


func _init() -> void:
	var path := "res://barcelona/tiles/tile_7_1_buildings.glb"
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		path = args[0]
	var root: Node = (load(path) as PackedScene).instantiate()
	_walk(root, Transform3D.IDENTITY)
	root.free()
	quit()


func _walk(n: Node, xf: Transform3D) -> void:
	if n is Node3D:
		xf = xf * (n as Node3D).transform
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var mesh: Mesh = (n as MeshInstance3D).mesh
		for si in mesh.get_surface_count():
			var arrays := mesh.surface_get_arrays(si)
			var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var idx: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			var n_i := idx.size()
			for t in range(0, n_i, 3):
				var a := xf * verts[idx[t]]
				var b := xf * verts[idx[t + 1]]
				var c := xf * verts[idx[t + 2]]
				print("T,%f,%f,%f,%f,%f,%f" % [a.x, a.z, b.x, b.z, c.x, c.z])
	for ch in n.get_children():
		_walk(ch, xf)
