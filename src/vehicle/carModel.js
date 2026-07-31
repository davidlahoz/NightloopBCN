/**
 * Vendored hero car — "Classic Muscle car" by Lexyc16 (Sketchfab, CC-BY 4.0,
 * see ASSETS.md). Loads the GLB, normalises orientation/scale to the physics
 * frame (forward +z, up +y, length ≈ 4.9 m, wheels resting at y = 0), carves
 * the four baked-in-place wheel groups out into steer/spin pivots, and
 * retunes the glTF materials for the night city.
 *
 * The glTF root carries a negative-determinant (RH→LH) transform, so wheel
 * pivots are inserted INSIDE the original parent chain (never re-parented
 * across the handedness boundary — matrix decomposition of mirrored frames
 * mangles the geometry). Car-frame axle/up axes are transformed into that
 * local space once; per-frame steer/spin are axis-angle quaternions around
 * those local axes.
 *
 * Returns null on any failure so the procedural car stays as fallback.
 */
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import '@babylonjs/loaders/glTF/2.0/index.js';

const TARGET_LENGTH = 4.9;   // muscle-car length in metres

/** Hierarchy world bounds of a node (meshes only). */
function boundsOf(node, mn, mx) {
  mn.setAll(Infinity); mx.setAll(-Infinity);
  for (const mesh of node.getChildMeshes(false)) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    mn.minimizeInPlace(bb.minimumWorld);
    mx.maximizeInPlace(bb.maximumWorld);
  }
}

/**
 * @param {import('@babylonjs/core').Scene} scene
 */
export async function loadCarModel(scene) {
  let res;
  try {
    res = await SceneLoader.ImportMeshAsync('', '/assets/car/', 'classic-muscle-car.glb', scene);
  } catch (e) {
    console.warn('[NIGHTLOOP] car model load failed, keeping procedural car', e);
    return null;
  }
  const glbRoot = res.meshes.find((m) => m.name === '__root__') ?? res.meshes[0];

  const mn = new Vector3(), mx = new Vector3();
  const orient = new TransformNode('muscleOrient', scene);
  glbRoot.parent = orient;

  // ---- orientation: up = smallest span (cars are flatter than wide),
  // length = largest span, normalised to run along +z.
  boundsOf(orient, mn, mx);
  let span = mx.subtract(mn);
  if (span.z < span.y && span.z < span.x) {
    orient.rotation.x = -Math.PI / 2;                     // z-up source
    orient.computeWorldMatrix(true);
    boundsOf(orient, mn, mx);
    span = mx.subtract(mn);
  }
  if (span.x > span.z) {
    orient.rotation.y = (orient.rotation.y || 0) + Math.PI / 2;   // length x → z
    orient.computeWorldMatrix(true);
    boundsOf(orient, mn, mx);
    span = mx.subtract(mn);
  }

  // ---- scale + centre on a rotation-free wrapper ----
  const norm = new TransformNode('muscleNorm', scene);
  orient.parent = norm;
  const s = TARGET_LENGTH / Math.max(span.x, span.z);
  norm.scaling.setAll(s);
  norm.computeWorldMatrix(true);
  boundsOf(norm, mn, mx);
  norm.position.set(-(mn.x + mx.x) / 2, -mn.y, -(mn.z + mx.z) / 2);
  norm.computeWorldMatrix(true);

  // ---- wheel groups → steer/spin pivots, INSIDE the original chain -------
  // Wheels are the 'Cube.NNN*' transform groups; the body group is 'Cube_0'.
  const wheelGroups = res.transformNodes.filter((tn) => /^Cube\.\d+/.test(tn.name));
  const wheels = [];
  const wmn = new Vector3(), wmx = new Vector3();
  const invP = new Matrix();
  for (const g of wheelGroups) {
    const parent = g.parent;
    parent.computeWorldMatrix(true).invertToRef(invP);
    const P = parent.getWorldMatrix();

    boundsOf(g, wmn, wmx);
    const centerW = wmn.add(wmx).scale(0.5);
    const radius = (wmx.y - wmn.y) / 2;                   // world metres

    // car-frame axes expressed in the parent's local space
    const axleL = Vector3.TransformNormal(Vector3.Right(), invP).normalize();
    const upL = Vector3.TransformNormal(Vector3.Up(), invP).normalize();
    // world metres moved per local unit along upL
    const wPerL = Vector3.TransformNormal(upL, P).length();

    const centerP = Vector3.TransformCoordinates(centerW, invP);
    const pivot = new TransformNode(g.name + '_pivot', scene);
    pivot.parent = parent;
    pivot.position.copyFrom(centerP);
    pivot.rotationQuaternion = Quaternion.Identity();
    const spin = new TransformNode(g.name + '_spin', scene);
    spin.parent = pivot;
    spin.rotationQuaternion = Quaternion.Identity();
    // keep g's own placement (glTF stores it as a node matrix), just shift
    // it by the pivot offset so the net transform is unchanged at rest
    g.parent = spin;
    g.position.subtractInPlace(centerP);

    wheels.push({
      pivot, spin,
      centerP, axleL, upL,
      invWPerL: 1 / wPerL,
      radius,
      front: centerW.z > 0,
      left: centerW.x < 0,
    });
  }

  // ---- replace ALL loader materials with our own plain PBR materials -----
  // The glTF-loader material instances (clearcoat variant et al.) corrupt
  // other WebGPU pipelines in this Babylon version; freshly-built standard
  // PBRMaterials with the same colours are safe.
  const { PBRMaterial } = await import('@babylonjs/core/Materials/PBR/pbrMaterial.js');
  const mk = (name, r, g, b, metallic, roughness) => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = new Color3(r, g, b);
    m.metallic = metallic;
    m.roughness = roughness;
    m.enableSpecularAntiAliasing = true;
    return m;
  };
  const paint = mk('nlMusclePaint', 0.8, 0.214, 0.0, 0.35, 0.42);
  const chrome = mk('nlMuscleChrome', 0.75, 0.77, 0.8, 0.6, 0.3);
  const glass = mk('nlMuscleGlass', 0.5, 0.56, 0.62, 0.1, 0.08);
  glass.alpha = 0.6;
  const blackTrim = mk('nlMuscleTrim', 0.02, 0.02, 0.022, 0.1, 0.55);
  const rubber = mk('nlMuscleRubber', 0.015, 0.015, 0.016, 0.0, 0.92);
  const white = mk('nlMuscleWhite', 0.75, 0.75, 0.73, 0.2, 0.5);
  const tailMat = mk('nlMuscleTail', 0.6, 0.02, 0.01, 0.0, 0.4);
  tailMat.emissiveColor = new Color3(1.0, 0.08, 0.03);
  tailMat.emissiveIntensity = 1.2;

  const byName = {
    'Material': paint,
    'Material.001': chrome,
    'Material.003': glass,
    'Material.004': tailMat,   // rear lamp clusters (verified by test-colour)
    'Material.005': white,     // front headlight lenses
    'Material.006': blackTrim,
    'Material.007': blackTrim,
    'Material.008': tailMat,
    'Material.002': rubber,
  };
  const oldMats = new Set();
  for (const mesh of res.meshes) {
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    const mat = mesh.material;
    if (!mat) continue;
    oldMats.add(mat);
    mesh.material = byName[mat.name] ?? blackTrim;
  }
  for (const m of oldMats) m.dispose(true, false);

  return { visual: norm, wheels, tailMat };
}
