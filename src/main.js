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
import { params, defineParam, onParam } from './core/params.js';
import { quality, setQualityAndReload } from './core/quality.js';
import { Props } from './city/props.js';
import { Skyline } from './city/skyline.js';
import { Buildings } from './city/buildings.js';
import { Curbs } from './city/curbs.js';
import { SurfaceState } from './surface/stateBuffer.js';
import { WeatherSystem } from './weather/states.js';
import { Rain } from './weather/rain.js';
import { Glow } from './vfx/glow.js';
import { Steam } from './vfx/steam.js';
import { TyreFX } from './vfx/spray.js';
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
  if (quality.renderScale !== 1) engine.setHardwareScalingLevel(quality.renderScale);
  // quality preset selector (stores + reloads — pipelines are built per preset)
  defineParam('qualityPreset', quality.name, { label: 'quality (reloads)', section: 'post', options: ['low', 'medium', 'high'] });
  onParam('qualityPreset', (v) => { if (v !== quality.name) setQualityAndReload(v); });
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

  // city floor: dark ground under everything so no void is ever visible
  {
    const floor = BABYLON.MeshBuilder.CreateGround('cityFloor', { width: 2000, height: 2000 }, scene);
    floor.position.y = -0.35;
    const fm = new BABYLON.PBRMaterial('cityFloorMat', scene);
    fm.albedoColor = new BABYLON.Color3(0.020, 0.021, 0.024);
    fm.metallic = 0;
    fm.roughness = 0.95;
    floor.material = fm;
    floor.isPickable = false;
    floor.freezeWorldMatrix();
    floor.metadata = { nlNoShadow: true };
  }

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

  // atmosphere VFX
  const glow = new Glow(scene, props.getStreetlightHeads(), buildings.getNeonLights());
  cityModules.push(glow);
  const steam = new Steam(scene);
  cityModules.push(steam);

  // surface state buffer (tyres write, road reads)
  const surface = new SurfaceState(scene, roadMat);
  const tyreFX = new TyreFX(scene);


  // ---- vehicle + camera ----
  const input = new Input(canvas);
  const stats = new FrameStats();
  const car = new Car(scene);
  car.position.set(0, 0, -40);
  const chase = new ChaseCamera(scene);
  const post = new PostChain(scene, chase.cam);

  // weather/mood states (keys 1–5) — drives env params + physical wet lag
  const weather = new WeatherSystem(env, [...cityModules, roadMat], post, refreshRoadLights);
  const rain = new Rain(scene, env);
  defineParam('weatherScrub', -0.01, { label: 'transition scrub', section: 'weather', min: -0.01, max: 1, step: 0.01 });
  onParam('weatherScrub', (v) => { weather.scrub = v < 0 ? NaN : v; });

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

  // ---- pipeline warm-up: every weather-dependent pipeline renders at least
  // once behind the loading screen, so no mood key ever hitches ----
  {
    rain.mesh.setEnabled(true);
    rain.material.setFloat('rainRate', 1);
    steam.mesh.setEnabled(true);
    steam.material.setFloat('amount', 1);
    scene.render();
    scene.render();
    rain.mesh.setEnabled(false);
    rain.material.setFloat('rainRate', 0);
    weather._push();
  }

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

    // tyre contact patches write into the surface state buffer
    if (car.speed > 0.4) {
      const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
      const wvx = car.vx * cy + car.vz * sy;
      const wvz = -car.vx * sy + car.vz * cy;
      const il = 1 / (Math.hypot(wvx, wvz) + 1e-5);
      const dx = wvx * il, dz = wvz * il;
      const sp = car.speed;
      const clear = Math.min(0.12 + sp * 0.05, 0.8);
      const ridge = Math.min(sp * 0.06, 0.9);
      const slip = car.driftAmount * 0.7 + (input.brake && sp > 6 ? 0.35 : 0) + Math.abs(car.slipYawOffset) * 1.4;
      const rubber = sp > 4 ? Math.min(slip * 0.28, 0.5) * dt * 60 * 0.02 : 0;
      const len = Math.max(0.16, sp * dt * 0.85);
      const avail = params.roadWetness;
      for (let i = 0; i < 4; i++) {
        surface.addSplat(
          car.wheelContactX[i], car.wheelContactZ[i], dx, dz,
          len, 0.115, clear, ridge, 0.22, rubber, avail,
        );
      }
    }
    surface.update(dt, car.position.x, car.position.z, env.params);
    tyreFX.update(dt, car, params.roadWetness);

    weather.update(dt, input);
    rain.update(dt, chase.cam, env.params.rainRate);
    env.update(dt);
    env.updateShadowFollow(car.position.x, car.position.z);
    roadMat.update(dt, env, car.position.x, car.position.z, car.position.y);

    // headlights → road shader (positions in world space, beams aimed ahead)
    {
      const cy2 = Math.cos(car.yaw), sy2 = Math.sin(car.yaw);
      const px = car.position.x, py = car.position.y, pz = car.position.z;
      const hlI = weather.headlights;
      const setHL = (v, lx, ly, lz, w) => { v.x = px + lx * cy2 + lz * sy2; v.y = py + ly; v.z = pz - lx * sy2 + lz * cy2; v.w = w; };
      setHL(roadMat._hl0, -0.62, 0.68, 2.05, hlI);
      setHL(roadMat._hl1, 0.62, 0.68, 2.05, hlI);
      setHL(roadMat._ht0, -0.55, 0.0, 26, 0);
      setHL(roadMat._ht1, 0.55, 0.0, 26, 0);
      roadMat.material.setVector4('headlight0', roadMat._hl0);
      roadMat.material.setVector4('headlight1', roadMat._hl1);
      roadMat.material.setVector4('headlightTip0', roadMat._ht0);
      roadMat.material.setVector4('headlightTip1', roadMat._ht1);
      car.materials.setHeadlights(hlI);
    }
    input.endFrame();
    roadChunks.update(dt, car.position.x, car.position.z);
    for (let i = 0; i < cityModules.length; i++) {
      cityModules[i].update(dt, car.position.x, car.position.z);
    }

    post.setSpeed(car.speed);
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
