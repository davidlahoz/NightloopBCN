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
import { buildBudget } from './core/buildBudget.js';
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
import { Litter } from './vfx/litter.js';
import { HeadlightCones } from './vfx/headlightCones.js';
import { EngineAudio } from './audio/engine.js';
import { Speedo } from './ui/speedo.js';
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

  // city floor: dark ground under everything so no void is ever visible.
  // The city is endless, so the plane re-centres on the car in coarse snaps.
  let cityFloor;
  {
    cityFloor = BABYLON.MeshBuilder.CreateGround('cityFloor', { width: 3000, height: 3000 }, scene);
    cityFloor.position.y = -0.35;
    const fm = new BABYLON.PBRMaterial('cityFloorMat', scene);
    fm.albedoColor = new BABYLON.Color3(0.020, 0.021, 0.024);
    fm.metallic = 0;
    fm.roughness = 0.95;
    cityFloor.material = fm;
    cityFloor.isPickable = false;
    cityFloor.freezeWorldMatrix();
    cityFloor.metadata = { nlNoShadow: true };
  }
  const followCityFloor = (x, z) => {
    const sx = Math.round(x / 400) * 400;
    const sz = Math.round(z / 400) * 400;
    if (sx !== cityFloor.position.x || sz !== cityFloor.position.z) {
      cityFloor.unfreezeWorldMatrix();
      cityFloor.position.set(sx, -0.35, sz);
      cityFloor.computeWorldMatrix(true);
      cityFloor.freezeWorldMatrix();
    }
  };

  // city modules (buildings, curbs, skyline, props) — all endless streamers
  /** @type {Array<{applyEnvironment:Function,update:Function}>} */
  const cityModules = [];
  const props = new Props(scene, env);
  cityModules.push(props);
  const skyline = new Skyline(scene, env);
  cityModules.push(skyline);
  const buildings = new Buildings(scene, env);
  cityModules.push(buildings);
  const curbs = new Curbs(scene, env, roadMat);
  cityModules.push(curbs);

  // populate the streamers around the spawn (behind the loading screen)
  const SPAWN_X = 0, SPAWN_Z = -40;
  props.prewarm(SPAWN_X, SPAWN_Z);
  buildings.prewarm(SPAWN_X, SPAWN_Z);
  curbs.prewarm(SPAWN_X, SPAWN_Z);

  // city lights → road shader light buffer (nearest first: the buffer caps at
  // 96 and the streamed region holds more than that)
  let lightSelX = SPAWN_X, lightSelZ = SPAWN_Z;
  const _allLights = [];
  const refreshRoadLights = () => {
    _allLights.length = 0;
    for (const L of props.getStreetlightHeads()) _allLights.push(L);
    for (const L of buildings.getNeonLights()) _allLights.push(L);
    const cx = lightSelX, cz = lightSelZ;
    _allLights.sort((a, b) =>
      ((a.x - cx) * (a.x - cx) + (a.z - cz) * (a.z - cz)) -
      ((b.x - cx) * (b.x - cx) + (b.z - cz) * (b.z - cz)));
    roadMat.setLights([_allLights]);
  };
  refreshRoadLights();

  // atmosphere VFX
  const glow = new Glow(scene, props.getStreetlightHeads(), buildings.getNeonLights());
  cityModules.push(glow);
  const steam = new Steam(scene);
  cityModules.push(steam);
  const litter = new Litter(scene);
  cityModules.push(litter);

  // streamed light sets changed → re-select buffer + rebuild halos
  let lastLightsGen = props.lightsGen + buildings.lightsGen;
  const refreshLightGeometry = () => {
    refreshRoadLights();
    glow.rebuild(props.getStreetlightHeads(), buildings.getNeonLights());
  };

  // surface state buffer (tyres write, road reads)
  const surface = new SurfaceState(scene, roadMat);
  const tyreFX = new TyreFX(scene);


  // ---- vehicle + camera ----
  const input = new Input(canvas);
  const stats = new FrameStats();
  const car = new Car(scene);
  car.position.set(SPAWN_X, 0, SPAWN_Z);
  const chase = new ChaseCamera(scene);
  const post = new PostChain(scene, chase.cam);

  // volumetric headlight cones (rain/fog only)
  const cones = new HeadlightCones(scene, car);

  // procedural engine sound (starts on first input — autoplay policy)
  const engineAudio = new EngineAudio();
  const speedo = new Speedo();

  // weather/mood states (keys 1–5) — drives env params + physical wet lag
  const weather = new WeatherSystem(env, [...cityModules, roadMat], post, refreshRoadLights);
  const rain = new Rain(scene, env);
  defineParam('weatherScrub', -0.01, { label: 'transition scrub', section: 'weather', min: -0.01, max: 1, step: 0.01 });
  onParam('weatherScrub', (v) => { weather.scrub = v < 0 ? NaN : v; });
  // boot directly into a state for capture tooling: ?state=N (1 day, 2 afternoon, 3 night)
  const bootState = (() => {
    const s = parseInt(new URLSearchParams(location.search).get('state') ?? '', 10);
    return s >= 1 && s <= 3 ? s : 3;
  })();
  if (bootState !== 3) weather.jumpTo(bootState);

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
  const NL = { engine, scene, car, chase, env, roadMat, roadChunks, post, stats, weather, surface, engineAudio, props, buildings, curbs, skyline, ready: false, frame: 0, refreshRenderLists, cityModules, maxRenderMs: 0, maxSimMs: 0 };
  window.__NIGHTLOOP__ = NL;
  window.BABYLON = BABYLON; // debug console access

  loadingScreen.set(0.85, 'compiling pipelines');

  // ---- pipeline warm-up: every weather-dependent pipeline renders at least
  // once behind the loading screen, so no mood key ever hitches ----
  {
    // heaviest state first: night (steam + cones + halos + rain pipeline)
    weather.jumpTo(3);
    rain.update(1 / 60, chase.cam, 1);
    steam.mesh.setEnabled(true);
    steam.material.setFloat('amount', 1);
    cones.applyEnvironment(env, 1.2);
    // particle pipelines must compile now, not on the first puddle
    tyreFX.spray[0].emitRate = 400;
    tyreFX.spray[1].emitRate = 400;
    tyreFX.smoke.emitRate = 100;
    scene.render();
    scene.render();
    tyreFX.spray[0].emitRate = 0;
    tyreFX.spray[1].emitRate = 0;
    tyreFX.smoke.emitRate = 0;
    weather.jumpTo(1);   // full-sun day path
    scene.render();
    weather.jumpTo(bootState);
    rain.update(1 / 60, chase.cam, env.params.rainRate);
    scene.render();
  }


  // ---- main loop ----
  let lastT = performance.now();
  const MAX_STEP = 1 / 30;
  let lastStreamGen = -1;
  engine.runRenderLoop(() => {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    stats.push(now - lastT);
    lastT = now;
    if (dt > MAX_STEP) dt = MAX_STEP;

    buildBudget.beginFrame();
    input.beginFrame();
    // scripted-capture hook: force a glide without real pointer events
    if (NL.debugGlide) {
      input.rmb = true;
      input.mouseDX += NL.debugGlide;
    }
    car.update(dt, input, groundHeight);
    if (car.curbBump > 0) chase.shakeEnergy = Math.min(1, chase.shakeEnergy + car.curbBump);
    chase.update(dt, car, input, groundHeight);
    // first-person (bumper) view: the camera sits where the hood is — hide
    // the car so no body panels ever clip into frame
    car.setVisible(chase.mode !== 1);

    // tyre contact patches write into the surface state buffer
    if (car.speed > 0.4) {
      const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
      const wvx = car.vx * cy + car.vz * sy;
      const wvz = -car.vx * sy + car.vz * cy;
      const il = 1 / (Math.hypot(wvx, wvz) + 1e-5);
      const dx = wvx * il, dz = wvz * il;
      const sp = car.speed;
      const clear = Math.min(0.12 + sp * 0.05, 0.8);
      const slip = car.driftAmount * 0.7 + (input.brake && sp > 6 ? 0.35 : 0) + Math.abs(car.slipYawOffset) * 1.4;
      const rubber = sp > 4 ? Math.min(slip * 0.6, 1.0) * 0.055 * (dt * 90) : 0;
      const len = Math.max(0.16, sp * dt * 0.85);
      // Glide wake: sliding tyres clear a wider swath
      // (displaced-water ridges removed — they read as melting asphalt)
      const width = 0.115 * (1 + car.driftAmount * 0.9);
      for (let i = 0; i < 4; i++) {
        const rear = i >= 2;
        surface.addSplat(
          car.wheelContactX[i], car.wheelContactZ[i], dx, dz,
          len, rear ? width : 0.115, clear, 0, 0.22,
          rear ? rubber : rubber * 0.3, 0,
        );
      }
    }
    surface.update(dt, car.position.x, car.position.z, env.params);
    tyreFX.update(dt, car, params.roadWetness);
    engineAudio.update(dt, car, input);

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
      cones.applyEnvironment(env, hlI);
    }
    input.endFrame();
    roadChunks.update(dt, car.position.x, car.position.z);
    for (let i = 0; i < cityModules.length; i++) {
      cityModules[i].update(dt, car.position.x, car.position.z);
    }
    followCityFloor(car.position.x, car.position.z);

    // streamed world changed → refresh mirror/shadow lists + light buffers
    const streamGen = roadChunks.generation + curbs.generation + buildings.generation;
    if (streamGen !== lastStreamGen) {
      lastStreamGen = streamGen;
      refreshRenderLists();
    }
    const lightsGen = props.lightsGen + buildings.lightsGen;
    if (lightsGen !== lastLightsGen) {
      lastLightsGen = lightsGen;
      lightSelX = car.position.x; lightSelZ = car.position.z;
      refreshLightGeometry();
    }

    post.setSpeed(car.speed);
    const tR0 = performance.now();
    scene.render();
    const tR1 = performance.now();
    if (tR1 - tR0 > NL.maxRenderMs) NL.maxRenderMs = tR1 - tR0;
    const simMs = tR0 - now;
    if (simMs > NL.maxSimMs) NL.maxSimMs = simMs;
    overlay.update(now);
    speedo.update(now, car.speed);

    NL.frame++;
    if (!NL.ready && NL.frame === 8) {
      loadingScreen.hide();
      NL.ready = true;
    }
    // hero car GLB: importing the glTF during the synchronous boot renders
    // corrupts city PBR pipelines on WebGPU (black or blown shading). It is
    // only safe once the live render loop has presented real frames — so the
    // placeholder swaps out a few frames in, behind the loading-screen fade.
    if (NL.frame === 14 && !NL.carSwapStarted) {
      NL.carSwapStarted = true;
      car.swapToModel(scene);
    }
  });
}

main().catch((e) => {
  console.error('[NIGHTLOOP] boot failed', e);
  loadingScreen.set(1, 'boot failed — see console');
});
