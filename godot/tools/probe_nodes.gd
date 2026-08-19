extends SceneTree
func _init() -> void:
	var root: Node = (load("res://barcelona/tiles/tile_0_0_roads.glb") as PackedScene).instantiate()
	_walk(root, 0)
	root.free()
	quit()
func _walk(n: Node, depth: int) -> void:
	var info := ""
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var m: Mesh = (n as MeshInstance3D).mesh
		info = "  surfaces=%d" % m.get_surface_count()
		for si in m.get_surface_count():
			var arrays := m.surface_get_arrays(si)
			info += " [s%d verts=%d uv=%s]" % [si,
				(arrays[Mesh.ARRAY_VERTEX] as PackedVector3Array).size(),
				"y" if arrays[Mesh.ARRAY_TEX_UV] != null else "n"]
	print("%s%s (%s)%s" % ["  ".repeat(depth), n.name, n.get_class(), info])
	if depth < 3:
		for ch in n.get_children():
			_walk(ch, depth + 1)
