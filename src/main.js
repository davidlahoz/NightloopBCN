/**
 * NIGHTLOOP — bootstrap.
 * WebGPU only: if navigator.gpu is absent we show one line of text and stop.
 */
import * as BABYLON from '@babylonjs/core';
import { loadingScreen } from './core/loadingScreen.js';
import { Input } from './core/input.js';
import { FrameStats } from './core/stats.js';
import { Overlay } from './ui/overlay.js';
import { Car } from './vehicle/car.js';
import { ChaseCamera } from './camera/chaseCamera.js';
import groundVertex from './shaders/placeholderGround.vertex.wgsl?raw';
import groundFragment from './shaders/placeholderGround.fragment.wgsl?raw';

const canvas = document.getElementById('canvas');

/** Flat placeholder ground query — replaced by the road heightfield in M2. */
function groundHeight(x, z) {
  return 0;
}

async function main() {
  if (!navigator.gpu) {
    loadingScreen.showNoWebGPU();
    return;
  }
  loadingScreen.set(0.05, 'starting webgpu');

  const engine = new BABYLON.WebGPUEngine(canvas, {
    adaptToDeviceRatio: false,
    antialias: false,
    stencil: false,
  });
  await engine.initAsync();
  loadingScreen.set(0.25, 'engine ready');

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.06, 0.085, 1);
  scene.skipPointerMovePicking = true;
  scene.ambientColor = new BABYLON.Color3(0.1, 0.12, 0.16);

  // ---- placeholder world (M1) ----
  BABYLON.ShaderStore.ShadersStoreWGSL['placeholderGroundVertexShader'] = groundVertex;
  BABYLON.ShaderStore.ShadersStoreWGSL['placeholderGroundFragmentShader'] = groundFragment;
  const groundMat = new BABYLON.ShaderMaterial('placeholderGround', scene, {
    vertex: 'placeholderGround',
    fragment: 'placeholderGround',
  }, {
    attributes: ['position'],
    uniformBuffers: ['Scene', 'Mesh'],
    shaderLanguage: BABYLON.ShaderLanguage.WGSL,
  });
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 1200, height: 1200 }, scene);
  ground.material = groundMat;
  ground.freezeWorldMatrix();

  // a few blocks for parallax reference
  const blockMat = new BABYLON.StandardMaterial('block', scene);
  blockMat.diffuseColor = new BABYLON.Color3(0.09, 0.1, 0.12);
  blockMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.06);
  const rng = mulberry32(1234);
  for (let i = 0; i < 40; i++) {
    const w = 8 + rng() * 18, h = 8 + rng() * 30, d = 8 + rng() * 18;
    const b = BABYLON.MeshBuilder.CreateBox('b' + i, { width: w, height: h, depth: d }, scene);
    const ring = 60 + rng() * 240;
    const ang = rng() * Math.PI * 2;
    b.position.set(Math.cos(ang) * ring, h / 2, Math.sin(ang) * ring);
    b.material = blockMat;
    b.freezeWorldMatrix();
  }

  // ---- lights (placeholder until M2) ----
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -0.35, 0.6), scene);
  sun.intensity = 1.6;
  sun.diffuse = new BABYLON.Color3(1.0, 0.72, 0.45);
  const amb = new BABYLON.HemisphericLight('amb', new BABYLON.Vector3(0, 1, 0), scene);
  amb.intensity = 0.55;
  amb.diffuse = new BABYLON.Color3(0.45, 0.55, 0.75);
  amb.groundColor = new BABYLON.Color3(0.12, 0.12, 0.15);

  // ---- systems ----
  const input = new Input(canvas);
  const stats = new FrameStats();
  const car = new Car(scene);
  const chase = new ChaseCamera(scene);

  const inst = new BABYLON.SceneInstrumentation(scene);
  const counterResult = { draws: 0, tris: 0, meshes: 0 };
  const counters = () => {
    counterResult.draws = inst.drawCallsCounter ? inst.drawCallsCounter.current : 0;
    counterResult.tris = scene.totalActiveIndicesPerfCounter ? (scene.totalActiveIndicesPerfCounter.current / 3) | 0 : 0;
    counterResult.meshes = scene.getActiveMeshes().length;
    return counterResult;
  };
  const overlay = new Overlay(stats, counters);

  window.addEventListener('resize', () => engine.resize());

  // ---- debug / capture handle ----
  const NL = { engine, scene, car, chase, ready: false, frame: 0 };
  window.__NIGHTLOOP__ = NL;

  loadingScreen.set(0.7, 'compiling pipelines');

  // ---- main loop ----
  let lastT = performance.now();
  const MAX_STEP = 1 / 30;
  engine.runRenderLoop(() => {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    stats.push(now - lastT);
    lastT = now;
    if (dt > MAX_STEP) dt = MAX_STEP;

    input.beginFrame();
    car.update(dt, input, groundHeight);
    chase.update(dt, car, input, groundHeight);
    input.endFrame();

    scene.render();
    overlay.update(now);

    NL.frame++;
    if (!NL.ready && NL.frame === 5) {
      loadingScreen.hide();
      NL.ready = true;
    }
  });
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((e) => {
  console.error('[NIGHTLOOP] boot failed', e);
  loadingScreen.set(1, 'boot failed — see console');
});
