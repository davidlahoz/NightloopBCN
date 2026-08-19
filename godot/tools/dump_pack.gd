extends SceneTree
## Dump the car-pack showroom: node tree with world AABBs.
## Run: godot --headless --path . --script tools/dump_pack.gd


func _init() -> void:
	var packed: PackedScene = load("res://assets/car/generic_passenger_car_pack.glb")
	var root: Node = packed.instantiate()
	_walk(root, Transform3D.IDENTITY, 0)
	root.free()
	quit()


func _walk(n: Node, xf: Transform3D, depth: int) -> void:
	if n is Node3D:
		xf = xf * (n as Node3D).transform
	var info := ""
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		var ab: AABB = xf * (n as MeshInstance3D).mesh.get_aabb()
		var c := ab.get_center()
		info = "  MESH c=(%.2f,%.2f,%.2f) size=(%.2f,%.2f,%.2f)" % [
			c.x, c.y, c.z, ab.size.x, ab.size.y, ab.size.z]
	print("%s%s%s" % ["  ".repeat(depth), n.name, info])
	for ch in n.get_children():
		_walk(ch, xf, depth + 1)
