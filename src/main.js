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
import { Environment } from './weather/environment.js';
import { PostChain } from './post/postChain.js';
import { RoadMaterial } from './city/roadMaterial.js';
import { RoadChunks } from './city/roadChunks.js';
import { groundHeight } from './city/roadProfile.js';
import { Props } from './city/props.js';
import { Skyline } from './city/skyline.js';
import { Buildings } from './city/buildings.js';
import { Curbs } from './city/curbs.js';
import commonWgsl from './shaders/common.wgsl?raw';

const canvas = document.getElementById('canvas');

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
  loadingScreen.set(0.2, 'engine ready');

  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.05, 0.06, 0.085, 1);
  scene.skipPointerMovePicking = true;
  scene.autoClearDepthAndStencil = true;

  // shared WGSL helpers must exist before any material compiles
  BABYLON.ShaderStore.IncludesShadersStoreWGSL['nlCommon'] = commonWgsl;

  // ---- world systems ----
  loadingScreen.set(0.3, 'building the city');
  const env = new Environment(scene);
  const roadMat = new RoadMaterial(scene, env);
  const roadChunks = new RoadChunks(scene, roadMat.material);

  // city modules (buildings, curbs, skyline, props) integrate here as they land
  /** @type {Array<{applyEnvironment:Function,update:Function}>} */
  const cityModules = [];
  const props = new Props(scene, env);
  cityModules.push(props);
  const skyline = new Skyline(scene, env);
  cityModules.push(skyline);
  const buildings = new Buildings(scene, env);
  cityModules.push(buildings);
  const curbs = new Curbs(scene, env);
  cityModules.push(curbs);

  // city lights → road shader light buffer
  const refreshRoadLights = () => {
    roadMat.setLights([props.getStreetlightHeads(), buildings.getNeonLights()]);
  };
  refreshRoadLights();

  // ---- vehicle + camera ----
  const input = new Input(canvas);
  const stats = new FrameStats();
  const car = new Car(scene);
  car.position.set(0, 0, -40);
  const chase = new ChaseCamera(scene);
  const post = new PostChain(scene, chase.cam);

  // ---- mirror + shadow wiring ----
  const refreshRenderLists = () => {
    // mirror: everything except the road itself (the road can't reflect itself)
    const list = [];
    for (const m of scene.meshes) {
      if (m.name.startsWith('road_')) continue;
      if (m.metadata && m.metadata.nlNoMirror) continue;
      list.push(m);
    }
    roadMat.mirror.renderList = list;
    // sun shadow casters: near-field geometry only
    const sm = env.shadow.getShadowMap();
    sm.renderList = [];
    for (const m of scene.meshes) {
      if (m.name.startsWith('road_') || m === env.sky) continue;
      if (m.name.toLowerCase().includes('skyline')) continue;
      if (m.metadata && m.metadata.nlNoShadow) continue;
      sm.renderList.push(m);
    }
  };
  refreshRenderLists();

  loadingScreen.set(0.55, 'paving the streets');
  roadChunks.prewarm(car.position.x, car.position.z);

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
  const NL = { engine, scene, car, chase, env, roadMat, roadChunks, post, ready: false, frame: 0, refreshRenderLists, cityModules };
  window.__NIGHTLOOP__ = NL;
  window.BABYLON = BABYLON; // debug console access

  loadingScreen.set(0.85, 'compiling pipelines');

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

    env.update(dt);
    env.updateShadowFollow(car.position.x, car.position.z);
    roadMat.update(dt, env, car.position.x, car.position.z, car.position.y);
    roadChunks.update(dt, car.position.x, car.position.z);
    for (let i = 0; i < cityModules.length; i++) {
      cityModules[i].update(dt, car.position.x, car.position.z);
    }

    scene.render();
    overlay.update(now);

    NL.frame++;
    if (!NL.ready && NL.frame === 8) {
      loadingScreen.hide();
      NL.ready = true;
    }
  });
}

main().catch((e) => {
  console.error('[NIGHTLOOP] boot failed', e);
  loadingScreen.set(1, 'boot failed — see console');
});
