<!--
  ParticleBackground.vue
  3D 粒子播放动画背景 — 移植自 Mineradio 项目

  核心功能:
  - Three.js 粒子舞台 (封面采样着色, 6 个视觉预设)
  - 实时音频频谱驱动 (bass / mid / treble / energy)
  - 节拍检测引擎 (onset 检测, 五段能量分析)
  - 电影镜头系统 (节拍驱动相机 punch / zoom / 微震)
  - Bloom 辉光层 (AdditiveBlending)
  - 涟漪交互 (预设切换 / 节拍触发)
  - 封面纹理渐变切歌

  接入方式:
  - 从 ControlAudioStore 获取音频元素与播放状态
  - 通过 audioManager.createAnalyser() 获取频谱数据
  - 从 GlobalPlayStatusStore 获取封面图片
  - 由 playSetting.particleBg 控制开关
-->
<template>
  <div ref="containerRef" class="particle-bg-container" />
</template>

<script lang="ts" setup>
import * as THREE from 'three'
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { useMineradioFxStore } from '@renderer/store/mineradioFx'
import audioManager from '@renderer/utils/audio/audioManager'
import {
  particleVertexShader,
  particleFragmentShader,
  bloomVertexShader,
  bloomFragmentShader,
  skullVertexShader,
  skullFragmentShader,
  floatVertexShader,
  floatFragmentShader
} from './particleShaders'

// ============================================================
//  Props
// ============================================================
const props = withDefaults(
  defineProps<{
    show?: boolean
  }>(),
  { show: false }
)

// ============================================================
//  Store
// ============================================================
const controlAudio = ControlAudioStore()
const { Audio } = storeToRefs(controlAudio)
const globalPlayStatus = useGlobalPlayStatusStore()
const { player } = storeToRefs(globalPlayStatus)
const fxStore = useMineradioFxStore()

// ============================================================
//  常量 & 工具
// ============================================================
const PLANE_SIZE = 4.8
const RIPPLE_MAX = 12
const PARTICLE_GRID = 110
const BASE_FOV = 45

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
function clampRange(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ============================================================
//  预设定义
// ============================================================
interface PresetDef {
  id: number
  label: string
  name: string
  desc: string
  radius: number
  phi: number
  theta: number
}
const presetList: PresetDef[] = [
  { id: 0, label: '丝绸', name: 'SILK', desc: '丝绸 — xy 平面涟漪 + 低频呼吸', radius: 6.6, phi: 0.08, theta: 0.0 },
  { id: 1, label: '隧道', name: 'TUNNEL', desc: '隧道 — 圆管自旋 + bass 收缩', radius: 6.2, phi: 0.03, theta: 0.0 },
  { id: 2, label: '星球', name: 'ORBIT', desc: '星球 — 球面膨胀 + treble 闪烁', radius: 7.0, phi: 0.15, theta: 0.0 },
  { id: 3, label: '虚空', name: 'VOID', desc: '虚空 — 隐藏粒子, 让位背景', radius: 8.0, phi: 0.05, theta: 0.0 },
  { id: 4, label: '黑胶', name: 'VINYL', desc: '黑胶 — 唱片封面 + 纹槽', radius: 6.5, phi: 0.04, theta: 0.0 },
  { id: 5, label: '壁纸', name: 'WALLPAPER', desc: '壁纸 — 极光带 + 深度火花', radius: 9.4, phi: 0.34, theta: -0.52 },
  { id: 6, label: '骷髅', name: 'SKULL', desc: '骷髅 — 骨骼光照 + 下颚开合 + 节拍闪光', radius: 7.4, phi: 0.10, theta: 0.18 }
]

// ============================================================
//  Three.js 状态
// ============================================================
const containerRef = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let particles: THREE.Points | null = null
let bloomParticles: THREE.Points | null = null
let geometry: THREE.BufferGeometry | null = null
let material: THREE.ShaderMaterial | null = null
let bloomMaterial: THREE.ShaderMaterial | null = null
let dotTexture: THREE.CanvasTexture | null = null
let coverTex: THREE.Texture | null = null
let prevCoverTex: THREE.Texture | null = null
let coverEdgeTex: THREE.Texture | null = null
let rippleTex: THREE.DataTexture | null = null
let coverCanvas: HTMLCanvasElement
let coverCtx: CanvasRenderingContext2D
let prevCoverCanvas: HTMLCanvasElement
let prevCoverCtx: CanvasRenderingContext2D

// 骷髅粒子 (预设6)
let skullGroup: THREE.Points | null = null
let skullMaterial: THREE.ShaderMaterial | null = null
let skullOpacity = 0
let skullBeatFlash = 0
let skullJawOpen = 0
const SKULL_SCALE = 2.34
const SKULL_ROT_X = -0.26

// 浮空粒子层
let floatGroup: THREE.Points | null = null
let floatMaterial: THREE.ShaderMaterial | null = null
const FLOAT_COUNT = 1300

let uniforms: Record<string, { value: any }>
let rafId = 0
let prevTime = 0
let disposed = false

// ============================================================
//  可视参数 (fx) — 来自 mineradioFx store
//  持久化、与 FxConsole 共享; Pinia option store 把 state 暴露为实例属性,
//  故 fx.intensity / fx.preset 等读取即 store 读取 (响应式)
// ============================================================
const fx = fxStore

// ============================================================
//  相机轨道系统
// ============================================================
const orbit = {
  userTheta: 0.0,
  userPhi: 0.08,
  userRadius: 6.6,
  cineTheta: 0.0,
  cinePhi: 0.0,
  cineRadius: 0.0,
  theta: 0.0,
  phi: 0.08,
  radius: 6.6,
  minPhi: -Math.PI * 0.45,
  maxPhi: Math.PI * 0.45,
  minRadius: 2.4,
  maxRadius: 14.0,
  baselineTheta: 0.0,
  baselinePhi: 0.08,
  baselineRadius: 6.6,
  lookAt: new THREE.Vector3(0, 0, 0)
}
let cinemaT = 0
let camPunch = 0

// 节拍相机
const beatCam = {
  punch: 0,
  thetaKick: 0,
  phiKick: 0,
  radiusKick: 0,
  rollKick: 0,
  minInterval: 0.42,
  lastAt: -10
}

// ============================================================
//  节拍引擎状态
// ============================================================
const rtBeat = {
  subFast: 0, subSlow: 0, subPeak: 0.045, prevSub: 0,
  lowFast: 0, lowSlow: 0, lowPeak: 0.060, prevLow: 0,
  bodyFast: 0, bodySlow: 0, bodyPeak: 0.040, prevBody: 0,
  vocalFast: 0, vocalSlow: 0, vocalPeak: 0.040, prevVocal: 0,
  snapFast: 0, snapSlow: 0, snapPeak: 0.035, prevSnap: 0,
  prevRms: 0,
  onsetAvg: 0,
  onsetPeak: 0.032,
  score: 0,
  pulse: 0,
  tempoGap: 0,
  tempoConfidence: 0,
  lastHitAt: -10,
  beatCount: 0,
  primedFrames: 0,
  warmupUntil: 1.5
}

// 频谱平滑值
let smoothBass = 0
let smoothMid = 0
let smoothTreb = 0
let smoothEnergy = 0
let beatPulse = 0
let bassPeak = 0.03
let midPeak = 0.026
let treblePeak = 0.018
let energyPeak = 0.03
let prevEnergy = 0
let bass = 0
let mid = 0
let treble = 0
let audioEnergy = 0

// ============================================================
//  涟漪
// ============================================================
let rippleData: Float32Array
const ripples: { x: number; y: number; age: number; str: number }[] = []

// ============================================================
//  预设转场
// ============================================================
const presetTransition = {
  active: false,
  start: 0,
  duration: 0.24,
  from: 0,
  to: 0
}

// ============================================================
//  响应式状态
// ============================================================
// 预设切换由 FxConsole 写入 fxStore.preset, 此处 watch 后应用;
// currentPreset 仅作内部去重标记
let currentPreset = 0

// ============================================================
//  音频分析器
// ============================================================
const visualAnalyserId = `particle-bg-visual-${Date.now()}-${Math.random()}`
const beatAnalyserId = `particle-bg-beat-${Date.now()}-${Math.random()}`
let visualAnalyser: AnalyserNode | null = null
let beatAnalyser: AnalyserNode | null = null
let frequencyData: Uint8Array | null = null
let timeDomainData: Uint8Array | null = null
let beatFrequencyData: Uint8Array | null = null
let beatTimeDomainData: Uint8Array | null = null

// ============================================================
//  初始化 Three.js
// ============================================================
function initThree() {
  if (!containerRef.value || renderer) return

  scene = new THREE.Scene()
  scene.background = null

  const w = containerRef.value.clientWidth || window.innerWidth
  const h = containerRef.value.clientHeight || window.innerHeight

  camera = new THREE.PerspectiveCamera(BASE_FOV, w / h, 0.1, 100)

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    powerPreference: 'high-performance'
  })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.setClearColor(0x000000, 0)
  containerRef.value.appendChild(renderer.domElement)
  renderer.domElement.style.position = 'absolute'
  renderer.domElement.style.top = '0'
  renderer.domElement.style.left = '0'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.zIndex = '-1'
}

// ============================================================
//  点纹理 (径向圆点)
// ============================================================
function makeDotTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 64
  const ctx = cv.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31)
  g.addColorStop(0.0, 'rgba(255,255,255,0.96)')
  g.addColorStop(0.42, 'rgba(255,255,255,0.78)')
  g.addColorStop(0.72, 'rgba(255,255,255,0.22)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(cv)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  return tex
}

// ============================================================
//  粒子几何体
// ============================================================
function buildParticleGeometry(grid: number): THREE.BufferGeometry {
  const count = grid * grid
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)
  const rand = new Float32Array(count)
  const texelStep = 1 / grid
  for (let i = 0; i < count; i++) {
    const gx = i % grid
    const gy = Math.floor(i / grid)
    const u = (gx + 0.5) * texelStep
    const v = (gy + 0.5) * texelStep
    const px = gx / (grid - 1)
    const py = gy / (grid - 1)
    positions[i * 3] = (px - 0.5) * PLANE_SIZE
    positions[i * 3 + 1] = (py - 0.5) * PLANE_SIZE
    positions[i * 3 + 2] = 0
    uvs[i * 2] = u
    uvs[i * 2 + 1] = v
    rand[i] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2))
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1))
  return geo
}

// ============================================================
//  初始化粒子系统
// ============================================================
function initParticles() {
  if (!scene || !renderer) return

  // 点纹理
  dotTexture = makeDotTexture()

  // 封面画布 (256×256)
  coverCanvas = document.createElement('canvas')
  coverCanvas.width = coverCanvas.height = 256
  coverCtx = coverCanvas.getContext('2d')!
  coverCtx.fillStyle = '#1c1c28'
  coverCtx.fillRect(0, 0, 256, 256)

  prevCoverCanvas = document.createElement('canvas')
  prevCoverCanvas.width = prevCoverCanvas.height = 256
  prevCoverCtx = prevCoverCanvas.getContext('2d')!
  prevCoverCtx.fillStyle = '#1c1c28'
  prevCoverCtx.fillRect(0, 0, 256, 256)

  coverTex = new THREE.Texture(coverCanvas)
  coverTex.minFilter = THREE.LinearFilter
  coverTex.magFilter = THREE.LinearFilter
  coverTex.wrapS = THREE.ClampToEdgeWrapping
  coverTex.wrapT = THREE.ClampToEdgeWrapping
  coverTex.needsUpdate = true

  prevCoverTex = new THREE.Texture(prevCoverCanvas)
  prevCoverTex.minFilter = THREE.LinearFilter
  prevCoverTex.magFilter = THREE.LinearFilter
  prevCoverTex.needsUpdate = true

  // 边缘/深度纹理 (简化: 纯默认值, 不做边缘检测)
  const edgeCv = document.createElement('canvas')
  edgeCv.width = edgeCv.height = 4
  const edgeCx = edgeCv.getContext('2d')!
  edgeCx.fillStyle = 'rgba(128,0,0,255)'
  edgeCx.fillRect(0, 0, 4, 4)
  coverEdgeTex = new THREE.Texture(edgeCv)
  coverEdgeTex.minFilter = THREE.LinearFilter
  coverEdgeTex.magFilter = THREE.LinearFilter
  coverEdgeTex.needsUpdate = true

  // 涟漪数据纹理
  rippleData = new Float32Array(RIPPLE_MAX * 4)
  rippleTex = new THREE.DataTexture(rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType)
  rippleTex.magFilter = THREE.NearestFilter
  rippleTex.minFilter = THREE.NearestFilter
  for (let i = 0; i < RIPPLE_MAX; i++) {
    ripples.push({ x: 0, y: 0, age: -10, str: 0 })
  }

  // Uniforms
  uniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uBeat: { value: 0 },
    uEnergy: { value: 0 },
    uBurstAmt: { value: 0 },
    uVinylSpin: { value: 0 },
    uPreset: { value: 0 },
    uIntensity: { value: fx.intensity },
    uDepth: { value: fx.depth },
    uPointScale: { value: fx.point },
    uSpeed: { value: fx.speed },
    uTwist: { value: fx.twist },
    uColorBoost: { value: fx.color },
    uScatter: { value: fx.scatter },
    uCoverRes: { value: 1.0 },
    uBgFade: { value: fx.bgFade },
    uBloomStrength: { value: fx.bloomStrength },
    uBloomSize: { value: 2.65 },
    uTintColor: { value: new THREE.Color('#9db8cf') },
    uTintStrength: { value: 0 },
    uCoverTex: { value: coverTex },
    uPrevCoverTex: { value: prevCoverTex },
    uColorMixT: { value: 1.0 },
    uEdgeTex: { value: coverEdgeTex },
    uRippleTex: { value: rippleTex },
    uRippleCount: { value: 0 },
    uDotTex: { value: dotTexture },
    uHasCover: { value: 0 },
    uHasDepth: { value: 0 },
    uEdgeEnabled: { value: 0 },
    uAiBoost: { value: 0 },
    uMouseXY: { value: new THREE.Vector2(-999, -999) },
    uMouseActive: { value: 0 },
    uHandXY: { value: new THREE.Vector2(-999, -999) },
    uHandActive: { value: 0 },
    uGestureGrip: { value: 0 },
    uPixel: { value: renderer ? renderer.getPixelRatio() : 1 },
    uAlpha: { value: 0 },
    uParticleDim: { value: 1 },
    uFloatAlpha: { value: 0 },
    uLoading: { value: 0 }
  }

  // 几何体
  geometry = buildParticleGeometry(PARTICLE_GRID)

  // 材质
  material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending
  })

  bloomMaterial = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: bloomVertexShader,
    fragmentShader: bloomFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  })

  // 粒子对象
  bloomParticles = new THREE.Points(geometry, bloomMaterial)
  bloomParticles.frustumCulled = false
  bloomParticles.renderOrder = 0
  scene.add(bloomParticles)

  particles = new THREE.Points(geometry, material)
  particles.frustumCulled = false
  particles.renderOrder = 1
  scene.add(particles)
}

// ============================================================
//  封面加载
// ============================================================
//  骷髅粒子 (预设6) — 程序化生成点位
// ============================================================
function buildSkullGeometry(): THREE.BufferGeometry {
  const pos: number[] = []
  const seed: number[] = []
  const kind: number[] = []

  function pushPoint(x: number, y: number, z: number, k: number) {
    pos.push(x, y, z)
    seed.push(Math.random() * 1000)
    kind.push(k)
  }
  function pushCurve(count: number, fn: (t: number) => { x: number; y: number; z: number }, k: number, jitter = 0.012) {
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0
      const p = fn(t)
      pushPoint(p.x + (Math.random() - 0.5) * jitter, p.y + (Math.random() - 0.5) * jitter, p.z + (Math.random() - 0.5) * jitter, k)
    }
  }
  function rotate2(x: number, y: number, a: number) {
    const c = Math.cos(a), s = Math.sin(a)
    return { x: x * c - y * s, y: x * s + y * c }
  }
  function eyeCut(x: number, y: number, z: number, side: number) {
    if (z < 0.16) return false
    const p = rotate2(x - side * 0.38, y - 0.02, side * 0.10)
    const almond = Math.pow(Math.abs(p.x) / 0.34, 1.70) + Math.pow(Math.abs(p.y) / 0.215, 1.34)
    const slantGate = p.y < 0.22 - Math.abs(p.x) * 0.12 && p.y > -0.24 + Math.abs(p.x) * 0.10
    return almond < 1.0 && slantGate
  }
  function noseCut(x: number, y: number, z: number) {
    if (z < 0.20 || y > -0.12 || y < -0.62) return false
    const t = clampRange((-0.12 - y) / 0.50, 0, 1)
    const half = 0.050 + t * 0.185
    return Math.abs(x) < half && z > 0.38 + t * 0.18
  }
  function mouthGap(x: number, y: number, z: number) {
    return z > 0.18 && y < -0.66 && y > -1.03 && Math.abs(x) < 0.30
  }
  function addEllipsoid(count: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, yMin: number, yMax: number, k: number, frontBias: boolean) {
    let made = 0, guard = 0
    while (made < count && guard < count * 8) {
      guard++
      const theta = frontBias ? (-Math.PI * 0.07 + Math.random() * Math.PI * 1.14) : (Math.random() * Math.PI * 2)
      const phi = Math.acos(1 - Math.random() * 2)
      const sx = Math.sin(phi) * Math.cos(theta)
      const sy = Math.cos(phi)
      const sz = Math.sin(phi) * Math.sin(theta)
      const x = cx + sx * rx * (0.96 + Math.max(0, -sy) * 0.12)
      const y = cy + sy * ry
      const z = cz + sz * rz
      if (y < yMin || y > yMax) continue
      if (eyeCut(x, y, z, -1) || eyeCut(x, y, z, 1) || noseCut(x, y, z) || mouthGap(x, y, z)) continue
      const cheekCarve = z > 0.18 && y < -0.18 && y > -0.66 && Math.abs(x) > 0.26 && Math.abs(x) < 0.58 && Math.random() < 0.36
      if (cheekCarve) continue
      pushPoint(x, y, z, k + Math.random() * 0.08)
      made++
    }
  }

  // 头骨
  addEllipsoid(3150, 0, 0.46, 0.00, 0.93, 0.88, 0.58, -0.16, 1.35, 0.055, true)
  // 下颚
  addEllipsoid(2100, 0, -0.34, 0.10, 0.70, 0.66, 0.46, -0.95, 0.14, 1.10, true)
  // 下巴
  for (let j = 0; j < 1450; j++) {
    const a = Math.random() * Math.PI * 2
    const v = Math.random()
    const y = -1.16 + v * 0.48
    const taper = clampRange((y + 1.16) / 0.48, 0, 1)
    const rx = 0.32 + taper * 0.31
    const rz = 0.22 + taper * 0.18
    const x = Math.cos(a) * rx
    const z = 0.22 + Math.sin(a) * rz
    if (mouthGap(x, y, z)) continue
    if (y > -0.94 && Math.abs(x) < 0.22 && z > 0.18) continue
    pushPoint(x, y, z, 1.15 + Math.random() * 0.10)
  }
  // 眼眶
  for (const side of [-1, 1]) {
    const cx = side * 0.38
    pushCurve(520, (t) => {
      const a = t * Math.PI * 2
      const px = Math.cos(a) * (0.345 + Math.sin(a * 2.0) * 0.012)
      const py = Math.sin(a) * (0.205 + Math.cos(a * 2.0) * 0.010)
      const r = rotate2(px, py, -side * 0.10)
      return { x: cx + r.x, y: 0.02 + r.y - Math.max(0, Math.cos(a)) * 0.018, z: 0.72 + Math.sin(a * 2.0) * 0.030 }
    }, 0.96, 0.010)
  }
  // 颧骨
  for (const side of [-1, 1]) {
    pushCurve(330, (t) => ({ x: side * (0.13 + t * 0.58), y: 0.245 - t * 0.085 + Math.sin(t * Math.PI) * 0.055, z: 0.66 + Math.sin(t * Math.PI) * 0.055 }), 0.98, 0.010)
    pushCurve(300, (t) => ({ x: side * (0.30 + t * 0.47), y: -0.18 - t * 0.25 + Math.sin(t * Math.PI) * 0.070, z: 0.69 - t * 0.095 }), 0.84, 0.012)
    pushCurve(330, (t) => ({ x: side * (0.62 - t * 0.20), y: -0.28 - t * 0.55 + Math.sin(t * Math.PI) * 0.065, z: 0.50 + Math.sin(t * Math.PI) * 0.070 }), 0.72, 0.014)
  }
  // 鼻梁
  pushCurve(360, (t) => { const x = -0.72 + t * 1.44; return { x, y: 0.235 - Math.abs(x) * 0.055 + Math.sin(t * Math.PI) * 0.035, z: 0.62 + Math.sin(t * Math.PI) * 0.040 } }, 0.86, 0.012)
  // 牙齿
  for (let tooth = -4; tooth <= 4; tooth++) {
    const tx = tooth * 0.082
    const height = tooth === 0 ? 0.30 : (0.25 + (4 - Math.abs(tooth)) * 0.012)
    pushCurve(58, (t) => ({ x: tx + Math.sin(t * Math.PI) * 0.006, y: -0.715 - t * height, z: 0.735 - t * 0.020 }), 0.94, 0.004)
  }
  // 头顶弧线
  pushCurve(520, (t) => { const a = Math.PI * 0.12 + t * Math.PI * 0.76; return { x: Math.cos(a) * 0.98, y: 0.42 + Math.sin(a) * 0.92, z: 0.48 + Math.sin(t * Math.PI) * 0.10 } }, 0.70, 0.012)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('seed', new THREE.BufferAttribute(new Float32Array(seed), 1))
  geo.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(kind), 1))
  return geo
}

function createSkullLayer() {
  if (skullGroup || !scene || !dotTexture) return
  const geo = buildSkullGeometry()
  skullMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: dotTexture },
      uTime: uniforms.uTime,
      uPixel: uniforms.uPixel,
      uBass: uniforms.uBass,
      uMid: uniforms.uMid,
      uTreble: uniforms.uTreble,
      uBeat: uniforms.uBeat,
      uJawOpen: { value: 0 },
      uSkullFlash: { value: 0 },
      uPointScale: uniforms.uPointScale,
      uBloomStrength: uniforms.uBloomStrength,
      uColorBoost: uniforms.uColorBoost,
      uOpacity: { value: 0 },
      uColorA: { value: new THREE.Color('#b8ae98') },
      uColorB: { value: new THREE.Color('#fff4d8') },
      uShadow: { value: new THREE.Color('#100d0d') },
      uLight: { value: new THREE.Color('#ffe3a0') }
    },
    vertexShader: skullVertexShader,
    fragmentShader: skullFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending
  })
  skullGroup = new THREE.Points(geo, skullMaterial)
  skullGroup.frustumCulled = false
  skullGroup.visible = false
  skullGroup.position.set(0, 0.22, 0.10)
  skullGroup.scale.setScalar(SKULL_SCALE)
  skullGroup.rotation.x = SKULL_ROT_X
  skullGroup.renderOrder = 32
  scene.add(skullGroup)
}

function updateSkullLayer(dt: number) {
  const active = fx.preset === 6
  if (active && !skullGroup) createSkullLayer()
  if (!skullGroup) return
  const target = active ? 1 : 0
  skullOpacity += (target - skullOpacity) * Math.min(1, dt * (active ? 3.2 : 2.4))
  if (skullOpacity < 0.006 && !active) {
    skullGroup.visible = false
    return
  }
  skullGroup.visible = true
  if (skullMaterial) {
    skullMaterial.uniforms.uOpacity.value = skullOpacity * clampRange(0.78 + fx.intensity * 0.18, 0.56, 1.0)
    const beatTransient = clampRange(Math.max(0, beatPulse - 0.16) / 0.84, 0, 1.35)
    const flashTarget = clampRange(Math.pow(beatTransient, 1.34) * 1.08 + Math.max(0, bass - 0.60) * 0.18 * beatTransient, 0, 1)
    skullBeatFlash += (flashTarget - skullBeatFlash) * Math.min(1, dt * (flashTarget > skullBeatFlash ? 24.0 : 6.2))
    skullMaterial.uniforms.uSkullFlash.value = skullBeatFlash
    const jawTarget = clampRange(0.60 + (0.5 + 0.5 * Math.sin(uniforms.uTime.value * 0.50)) * 0.050 + bass * 0.060 + skullBeatFlash * 0.090, 0.52, 0.88)
    skullJawOpen += (jawTarget - skullJawOpen) * Math.min(1, dt * (jawTarget > skullJawOpen ? 7.8 : 3.4))
    skullMaterial.uniforms.uJawOpen.value = skullJawOpen
  }
  // 呼吸漂移
  const t = uniforms.uTime.value
  skullGroup.position.x += (0 + Math.sin(t * 0.33 + 1.7) * 0.028 - skullGroup.position.x) * Math.min(1, dt * 4.2)
  skullGroup.position.y += (0.22 + Math.sin(t * 0.38 + 0.2) * 0.036 - skullGroup.position.y) * Math.min(1, dt * 4.8)
  skullGroup.rotation.z += (0 - skullGroup.rotation.z) * Math.min(1, dt * 6.0)
}

// ============================================================
//  浮空粒子层
// ============================================================
function createFloatLayer() {
  if (floatGroup || !scene || !dotTexture) return
  const fgeo = new THREE.BufferGeometry()
  const positions = new Float32Array(FLOAT_COUNT * 3)
  const colors = new Float32Array(FLOAT_COUNT * 3)
  const phases = new Float32Array(FLOAT_COUNT * 3)
  const rands = new Float32Array(FLOAT_COUNT)
  const amps = new Float32Array(FLOAT_COUNT)
  for (let i = 0; i < FLOAT_COUNT; i++) {
    const halo = i < FLOAT_COUNT * 0.76
    let bx: number, by: number, bz: number
    if (halo) {
      const a = Math.random() * Math.PI * 2
      const r = 0.62 + Math.pow(Math.random(), 0.72) * 2.75
      const lane = (Math.random() - 0.5) * 0.62
      bx = Math.cos(a) * r
      by = Math.sin(a) * r * 0.54 + lane
      bz = (Math.random() - 0.5) * 2.4 - 0.25
    } else {
      bx = (Math.random() - 0.5) * 8.4
      by = (Math.random() - 0.5) * 5.8
      bz = (Math.random() - 0.5) * 5.6
    }
    positions[i * 3] = bx
    positions[i * 3 + 1] = by
    positions[i * 3 + 2] = bz
    phases[i * 3] = Math.random() * Math.PI * 2
    phases[i * 3 + 1] = Math.random() * Math.PI * 2
    phases[i * 3 + 2] = Math.random() * Math.PI * 2
    amps[i] = 0.15 + Math.random() * 0.35
    const white = 0.88 + Math.random() * 0.12
    colors[i * 3] = white
    colors[i * 3 + 1] = white
    colors[i * 3 + 2] = white
    rands[i] = Math.random()
  }
  fgeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  fgeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  fgeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 3))
  fgeo.setAttribute('aRand', new THREE.BufferAttribute(rands, 1))
  fgeo.setAttribute('aAmp', new THREE.BufferAttribute(amps, 1))
  floatMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uBass: uniforms.uBass,
      uPixel: uniforms.uPixel,
      uDotTex: { value: dotTexture },
      uFloatAlpha: { value: 0 }
    },
    vertexShader: floatVertexShader,
    fragmentShader: floatFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  })
  floatGroup = new THREE.Points(fgeo, floatMaterial)
  floatGroup.frustumCulled = false
  floatGroup.renderOrder = 2
  scene.add(floatGroup)
}

function updateFloatLayer(dt: number) {
  if (!floatGroup || !floatMaterial) return
  // 非骷髅预设时显示浮空粒子(作为氛围层)
  const targetAlpha = fx.preset !== 3 && fx.preset !== 6 ? 0.35 : 0
  const cur = floatMaterial.uniforms.uFloatAlpha.value
  floatMaterial.uniforms.uFloatAlpha.value += (targetAlpha - cur) * Math.min(1, dt * 2.0)
}

// ============================================================
let currentCoverUrl: string | null = null

function loadCover(url: string | undefined) {
  if (!url || url === currentCoverUrl) return
  currentCoverUrl = url

  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    if (disposed) return
    // 保存旧封面到 prev
    prevCoverCtx.clearRect(0, 0, 256, 256)
    prevCoverCtx.drawImage(coverCanvas, 0, 0)
    prevCoverTex!.needsUpdate = true
    // 绘制新封面
    coverCtx.clearRect(0, 0, 256, 256)
    coverCtx.drawImage(img, 0, 0, 256, 256)
    coverTex!.needsUpdate = true
    uniforms.uColorMixT.value = 0
    uniforms.uHasCover.value = 1
  }
  img.onerror = () => {
    if (disposed) return
    uniforms.uHasCover.value = 0
  }
  img.src = url
}

// ============================================================
//  音频分析器初始化
// ============================================================
function initAudio() {
  const audioEl = Audio.value.audio
  if (!audioEl) return

  try {
    visualAnalyser = audioManager.createAnalyser(audioEl, visualAnalyserId, 2048)
    beatAnalyser = audioManager.createAnalyser(audioEl, beatAnalyserId, 2048)
    // beat analyser 使用更低平滑度, 提高 onset 灵敏度
    if (beatAnalyser) {
      beatAnalyser.smoothingTimeConstant = 0.1
    }
    if (visualAnalyser) {
      frequencyData = new Uint8Array(new ArrayBuffer(visualAnalyser.frequencyBinCount))
      timeDomainData = new Uint8Array(new ArrayBuffer(visualAnalyser.frequencyBinCount))
    }
    if (beatAnalyser) {
      beatFrequencyData = new Uint8Array(new ArrayBuffer(beatAnalyser.frequencyBinCount))
      beatTimeDomainData = new Uint8Array(new ArrayBuffer(beatAnalyser.frequencyBinCount))
    }
  } catch (e) {
    console.error('ParticleBackground: 音频分析器初始化失败', e)
  }
}

function cleanupAudio() {
  try {
    audioManager.removeAnalyser(visualAnalyserId)
  } catch {}
  try {
    audioManager.removeAnalyser(beatAnalyserId)
  } catch {}
  visualAnalyser = null
  beatAnalyser = null
  frequencyData = null
  timeDomainData = null
  beatFrequencyData = null
  beatTimeDomainData = null
}

// ============================================================
//  频段 RMS 提取
// ============================================================
function beatBandRms(
  data: Uint8Array,
  sampleRate: number,
  fftSize: number,
  hz0: number,
  hz1: number
): number {
  const binHz = sampleRate / fftSize
  const a = Math.max(1, Math.floor(hz0 / binHz))
  const b = Math.min(data.length - 1, Math.ceil(hz1 / binHz))
  let sum = 0
  let count = 0
  for (let i = a; i <= b; i++) {
    const v = data[i] / 255
    sum += v * v
    count++
  }
  return count ? Math.sqrt(sum / count) : 0
}

// ============================================================
//  节拍引擎 (简化版, 移植自 Mineradio processRealtimeBeatEngine)
// ============================================================
function processBeatEngine(dt: number): { hit: boolean; strength: number; low: number } {
  if (!beatAnalyser || !Audio.value.audio || Audio.value.audio.paused) return { hit: false, strength: 0, low: 0 }

  dt = Math.max(0.001, Math.min(0.08, dt || 0.016))
  beatAnalyser.getByteFrequencyData(beatFrequencyData as Uint8Array<ArrayBuffer>)
  beatAnalyser.getByteTimeDomainData(beatTimeDomainData as Uint8Array<ArrayBuffer>)

  const sampleRate = 44100

  const sub = beatBandRms(beatFrequencyData!, sampleRate, beatAnalyser.fftSize, 38, 74)
  const kick = beatBandRms(beatFrequencyData!, sampleRate, beatAnalyser.fftSize, 52, 165)
  const body = beatBandRms(beatFrequencyData!, sampleRate, beatAnalyser.fftSize, 165, 420)
  const vocal = beatBandRms(beatFrequencyData!, sampleRate, beatAnalyser.fftSize, 420, 2600)
  const snap = beatBandRms(beatFrequencyData!, sampleRate, beatAnalyser.fftSize, 1800, 9200)
  const low = Math.min(1, kick * 0.86 + sub * 0.42)

  let rms = 0
  for (let i = 0; i < beatTimeDomainData!.length; i++) {
    const tv = (beatTimeDomainData![i] - 128) / 128
    rms += tv * tv
  }
  rms = Math.sqrt(rms / beatTimeDomainData!.length)

  function follow(cur: number, next: number, upTau: number, downTau: number): number {
    const tau = next > cur ? upTau : downTau
    return cur + (next - cur) * (1 - Math.exp(-dt / Math.max(0.001, tau)))
  }

  rtBeat.subFast = follow(rtBeat.subFast, sub, 0.018, 0.064)
  rtBeat.subSlow = follow(rtBeat.subSlow, sub, 0.32, 0.52)
  rtBeat.lowFast = follow(rtBeat.lowFast, low, 0.016, 0.070)
  rtBeat.lowSlow = follow(rtBeat.lowSlow, low, 0.30, 0.54)
  rtBeat.bodyFast = follow(rtBeat.bodyFast, body, 0.020, 0.082)
  rtBeat.bodySlow = follow(rtBeat.bodySlow, body, 0.36, 0.60)
  rtBeat.vocalFast = follow(rtBeat.vocalFast, vocal, 0.026, 0.090)
  rtBeat.vocalSlow = follow(rtBeat.vocalSlow, vocal, 0.34, 0.58)
  rtBeat.snapFast = follow(rtBeat.snapFast, snap, 0.012, 0.060)
  rtBeat.snapSlow = follow(rtBeat.snapSlow, snap, 0.30, 0.52)

  const peakDecay = 0.99
  rtBeat.subPeak = Math.max(rtBeat.subPeak * Math.pow(peakDecay, dt * 60), sub, 0.045)
  rtBeat.lowPeak = Math.max(rtBeat.lowPeak * Math.pow(0.989, dt * 60), low, 0.060)
  rtBeat.bodyPeak = Math.max(rtBeat.bodyPeak * Math.pow(peakDecay, dt * 60), body, 0.040)
  rtBeat.vocalPeak = Math.max(rtBeat.vocalPeak * Math.pow(peakDecay, dt * 60), vocal, 0.040)
  rtBeat.snapPeak = Math.max(rtBeat.snapPeak * Math.pow(peakDecay, dt * 60), snap, 0.035)

  const subFlux = Math.max(0, sub - rtBeat.prevSub)
  const lowFlux = Math.max(0, low - rtBeat.prevLow)
  const bodyFlux = Math.max(0, body - rtBeat.prevBody)
  const vocalFlux = Math.max(0, vocal - rtBeat.prevVocal)
  const snapFlux = Math.max(0, snap - rtBeat.prevSnap)
  const rmsFlux = Math.max(0, rms - rtBeat.prevRms)
  const subRise = Math.max(0, rtBeat.subFast - rtBeat.subSlow)
  const lowRise = Math.max(0, rtBeat.lowFast - rtBeat.lowSlow)
  const bodyRise = Math.max(0, rtBeat.bodyFast - rtBeat.bodySlow)
  const vocalRise = Math.max(0, rtBeat.vocalFast - rtBeat.vocalSlow)
  const snapRise = Math.max(0, rtBeat.snapFast - rtBeat.snapSlow)

  const drumOnset = subRise * 0.88 + subFlux * 0.66 + lowRise * 1.62 + lowFlux * 1.34
  const musicalOnset = bodyRise * 0.34 + bodyFlux * 0.24 + vocalRise * 0.52 + vocalFlux * 0.36 + snapRise * 0.08 + snapFlux * 0.06 + rmsFlux * 0.2
  const onset = drumOnset + musicalOnset * 0.16

  const avgTau = onset > rtBeat.onsetAvg ? 1.1 : 0.34
  rtBeat.onsetAvg = follow(rtBeat.onsetAvg, onset, avgTau, avgTau)
  rtBeat.onsetPeak = Math.max(rtBeat.onsetPeak * Math.pow(0.988, dt * 60), onset, 0.032)
  const floor = rtBeat.onsetAvg * 0.84
  const score = clamp01((onset - floor) / Math.max(0.014, rtBeat.onsetPeak - floor))

  const lowNorm = clamp01(low / Math.max(0.06, rtBeat.lowPeak * 0.72))
  const vocalNorm = clamp01(vocal / Math.max(0.045, rtBeat.vocalPeak * 0.72))
  const lowDominance = low / Math.max(0.001, vocal * 0.84 + body * 0.36 + snap * 0.1)
  const lowAttack = lowRise + lowFlux * 0.72 + subRise * 0.58 + subFlux * 0.4
  const lowPresence = Math.max(lowNorm, clamp01(sub / Math.max(0.045, rtBeat.subPeak * 0.7)) * 0.74)

  const voiceMask = vocalNorm > 0.58 && lowDominance < 0.86
  const drumGate = lowPresence > 0.38 && lowAttack > Math.max(0.014, rtBeat.onsetAvg * 0.34) && !voiceMask
  const strongTransient = drumGate && score > 0.54 && drumOnset > rtBeat.onsetAvg * 0.84
  const kickTransient = drumGate && score > 0.4 && lowAttack > Math.max(0.018, rtBeat.onsetAvg * 0.46)

  rtBeat.primedFrames++
  const nowT = Audio.value.audio.currentTime || 0
  const warmingUp = nowT < rtBeat.warmupUntil || rtBeat.primedFrames < 18

  let candidateHit = strongTransient || kickTransient
  if (warmingUp) candidateHit = false

  const gapRaw = nowT - rtBeat.lastHitAt
  let rhythmAccept = false
  if (candidateHit) {
    if (rtBeat.lastHitAt < 0) {
      rhythmAccept = strongTransient && score > 0.62 && lowPresence > 0.48
    } else {
      rhythmAccept = gapRaw >= beatCam.minInterval && strongTransient && score > 0.58 && lowPresence > 0.44
    }
  }
  let hit = candidateHit && rhythmAccept
  if (hit && gapRaw < 0.4) hit = false

  rtBeat.prevSub = sub
  rtBeat.prevLow = low
  rtBeat.prevBody = body
  rtBeat.prevVocal = vocal
  rtBeat.prevSnap = snap
  rtBeat.prevRms = rms
  rtBeat.score = score
  rtBeat.pulse *= Math.pow(0.18, dt)
  rtBeat.tempoConfidence *= Math.pow(0.996, dt * 60)

  if (!hit) {
    return { hit: false, strength: score, low: lowNorm }
  }

  // 节拍命中
  if (rtBeat.lastHitAt > 0) {
    let gap = nowT - rtBeat.lastHitAt
    while (gap > 0.88) gap *= 0.5
    while (gap < 0.42) gap *= 2.0
    if (gap >= 0.42 && gap <= 0.88) {
      const tempoEase = 0.22
      rtBeat.tempoGap = rtBeat.tempoGap ? rtBeat.tempoGap * (1 - tempoEase) + gap * tempoEase : gap
      rtBeat.tempoConfidence = Math.min(1, rtBeat.tempoConfidence + 0.18)
    }
  }
  rtBeat.lastHitAt = nowT
  rtBeat.beatCount++
  const strength = clamp01(0.24 + score * 0.36 + lowPresence * 0.34 + Math.min(1.25, lowDominance) * 0.07 + rmsFlux * 0.95)
  rtBeat.pulse = Math.max(rtBeat.pulse, strength)

  return { hit: true, strength, low: Math.max(0.05, lowPresence) }
}

// ============================================================
//  节拍相机调度
// ============================================================
function scheduleBeatCamera(strength: number, low: number) {
  const now = (Audio.value.audio?.currentTime) || 0
  if (now - beatCam.lastAt < beatCam.minInterval) return
  beatCam.lastAt = now

  const mode = low > 0.55 ? 'deep' : 'body'
  const amp = strength * (mode === 'deep' ? 0.5 : 0.34)
  beatCam.punch = Math.max(beatCam.punch, amp)
  beatCam.thetaKick = (Math.random() - 0.5) * amp * 0.08
  beatCam.phiKick = (Math.random() - 0.5) * amp * 0.06
  beatCam.radiusKick = Math.max(beatCam.radiusKick, amp * 0.18)
  beatCam.rollKick = (Math.random() - 0.5) * amp * 0.04
  camPunch = Math.max(camPunch, amp * 0.5)
}

function updateBeatCamera(dt: number) {
  const decay = Math.pow(0.3, dt)
  beatCam.punch *= decay
  beatCam.thetaKick *= decay
  beatCam.phiKick *= decay
  beatCam.radiusKick *= decay
  beatCam.rollKick *= decay
}

// ============================================================
//  电影镜头
// ============================================================
function updateCinema(dt: number) {
  cinemaT += dt
  updateBeatCamera(dt)
  if (!fx.cinema) {
    orbit.cineTheta *= 0.95
    orbit.cinePhi *= 0.95
    orbit.cineRadius *= 0.95
    return
  }
  const shake = clampRange(fx.cinemaShake, 0, 1.8)
  orbit.cineTheta = Math.sin(cinemaT * 0.08) * 0.012 * shake + beatCam.thetaKick * shake
  orbit.cinePhi = Math.sin(cinemaT * 0.06 + 1.0) * 0.01 * shake + beatCam.phiKick * shake
  orbit.cineRadius = Math.sin(cinemaT * 0.04 + 2.0) * 0.08 * shake - beatCam.radiusKick * shake * 1.18
}

// ============================================================
//  相机更新
// ============================================================
function updateCamera() {
  if (!camera) return

  const targetTheta = orbit.userTheta + orbit.cineTheta
  const targetPhi = Math.max(orbit.minPhi, Math.min(orbit.maxPhi, orbit.userPhi + orbit.cinePhi))
  const targetRadius = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.userRadius + orbit.cineRadius))

  let focusEase = 0.1
  let radiusEase = 0.07
  if (beatCam.punch > 0.01) {
    focusEase = Math.max(focusEase, 0.12 + beatCam.punch * 0.12)
    radiusEase = Math.max(radiusEase, 0.09 + beatCam.punch * 0.12)
  }
  orbit.theta += (targetTheta - orbit.theta) * focusEase
  orbit.phi += (targetPhi - orbit.phi) * focusEase
  orbit.radius += (targetRadius - orbit.radius) * radiusEase

  const cy = Math.cos(orbit.phi)
  const sy = Math.sin(orbit.phi)
  const ct = Math.cos(orbit.theta)
  const st = Math.sin(orbit.theta)
  camera.position.set(
    orbit.lookAt.x + orbit.radius * cy * st,
    orbit.lookAt.y + orbit.radius * sy,
    orbit.lookAt.z + orbit.radius * cy * ct
  )
  camera.lookAt(orbit.lookAt)

  const cameraShake = clampRange(fx.cinemaShake, 0, 1.8)
  camera.rotation.z += beatCam.rollKick * cameraShake

  const cameraPunch = Math.max(camPunch * 0.55, beatCam.punch * 0.54 + beatCam.radiusKick * 0.16) * cameraShake
  const targetFOV = BASE_FOV - cameraPunch * 2.35
  const fovEase = targetFOV < camera.fov ? 0.24 : 0.12
  camera.fov += (targetFOV - camera.fov) * fovEase
  camera.updateProjectionMatrix()
  camPunch *= 0.86
}

// ============================================================
//  涟漪
// ============================================================
function triggerRipple(x: number, y: number, str: number) {
  let oldest = 0
  let oldestAge = ripples[0].age
  for (let i = 1; i < RIPPLE_MAX; i++) {
    if (ripples[i].age < oldestAge) {
      oldestAge = ripples[i].age
      oldest = i
    }
  }
  ripples[oldest] = { x, y, age: 0, str }
}

function updateRipples(dt: number) {
  if (!rippleTex) return
  let count = 0
  for (let i = 0; i < RIPPLE_MAX; i++) {
    const r = ripples[i]
    if (r.str > 0.005 && r.age >= 0 && r.age < 2.0) {
      r.age += dt
      rippleData[i * 4] = r.x
      rippleData[i * 4 + 1] = r.y
      rippleData[i * 4 + 2] = r.age
      rippleData[i * 4 + 3] = r.str
      count++
    } else {
      rippleData[i * 4 + 3] = 0
    }
  }
  uniforms.uRippleCount.value = count
  rippleTex.needsUpdate = true
}

// ============================================================
//  预设系统
//  预设编号由 fxStore.preset 持有; FxConsole 写入 store,
//  此处 watch 后调用 applyPresetToEngine 应用到引擎
// ============================================================
function applyPresetToEngine(p: number, opts?: { transition?: boolean }) {
  const useTransition = opts?.transition !== false
  p = Math.max(0, Math.min(presetList.length - 1, p))
  const prev = currentPreset
  currentPreset = p
  uniforms.uPreset.value = p

  // 转场效果 (首次挂载时跳过)
  if (useTransition && prev !== p) {
    triggerPresetTransition(prev, p)
  }

  // 相机基线
  const def = presetList[p]
  orbit.userRadius = def.radius
  orbit.userPhi = def.phi
  orbit.userTheta = def.theta
  orbit.baselineRadius = def.radius
  orbit.baselinePhi = def.phi
  orbit.baselineTheta = def.theta
}

function triggerPresetTransition(_from: number, to: number) {
  presetTransition.active = true
  presetTransition.start = uniforms.uTime.value
  presetTransition.duration = to === 5 ? 0.3 : 0.24
  presetTransition.from = _from
  presetTransition.to = to
  const newVisual = to >= 4
  const wallpaperFlow = to === 5
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + (newVisual ? (wallpaperFlow ? 0.008 : 0.024) : 0.12))
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wallpaperFlow ? 0.05 : 0.15)
  camPunch = Math.max(camPunch, wallpaperFlow ? 0.04 : 0.12)
  for (let i = 0; i < 3; i++) {
    triggerRipple((Math.random() - 0.5) * 3.4, (Math.random() - 0.5) * 3.4, 0.58 + Math.random() * 0.32)
  }
}

function tickPresetTransition() {
  if (!presetTransition.active) return
  const raw = (uniforms.uTime.value - presetTransition.start) / presetTransition.duration
  const t = Math.max(0, Math.min(1, raw))
  const wave = Math.sin(t * Math.PI)
  const newVisual = presetTransition.to >= 4
  const wallpaperFlow = presetTransition.to === 5
  uniforms.uScatter.value = Math.max(uniforms.uScatter.value, fx.scatter + wave * (newVisual ? (wallpaperFlow ? 0.008 : 0.026) : 0.16))
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, wave * (wallpaperFlow ? 0.045 : newVisual ? 0.12 : 0.15))
  uniforms.uPointScale.value = fx.point * (1 + wave * (wallpaperFlow ? 0.016 : 0.048))
  if (raw >= 1) {
    presetTransition.active = false
    syncFxUniforms()
  }
}

function syncFxUniforms() {
  uniforms.uPreset.value = fx.preset
  uniforms.uIntensity.value = fx.intensity
  uniforms.uDepth.value = fx.depth
  uniforms.uPointScale.value = fx.point
  uniforms.uSpeed.value = fx.speed
  uniforms.uTwist.value = fx.twist
  uniforms.uColorBoost.value = fx.color
  uniforms.uScatter.value = fx.scatter
  uniforms.uBgFade.value = fx.bgFade
  uniforms.uCoverRes.value = fx.coverRes
  uniforms.uBloomStrength.value = fx.bloom ? fx.bloomStrength : 0
  if (bloomParticles) bloomParticles.visible = fx.bloom && fx.bloomStrength > 0.01
  uniforms.uEdgeEnabled.value = fx.edge ? 1 : 0
  // 视觉染色
  uniforms.uTintColor.value.set(fx.tintColor)
  uniforms.uTintStrength.value = fx.tintStrength
}

// 更新染色: tintAuto 时跟随封面主色
function updateTintFromCover() {
  if (fx.tintAuto) {
    const mc = player.value.coverDetail?.mainColor
    if (mc) {
      // rgba(r,g,b,a) -> hex
      const m = mc.match(/rgba?\(([^)]+)\)/)
      if (m) {
        const parts = m[1].split(',').map((s) => parseFloat(s.trim()))
        const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
        const hex = `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`
        uniforms.uTintColor.value.set(hex)
      }
    }
  } else {
    uniforms.uTintColor.value.set(fx.tintColor)
  }
  uniforms.uTintStrength.value = fx.tintStrength
}

// ============================================================
//  主动画循环
// ============================================================
function animate() {
  rafId = requestAnimationFrame(animate)
  if (disposed || !renderer || !scene || !camera) return

  const now = performance.now()
  const dt = Math.min((now - prevTime) / 1000, 0.05)
  prevTime = now
  uniforms.uTime.value += dt

  const playing = Audio.value.isPlay && Audio.value.audio && !Audio.value.audio.paused

  // === 频谱分析 ===
  if (visualAnalyser && playing && frequencyData && timeDomainData) {
    visualAnalyser.getByteFrequencyData(frequencyData as Uint8Array<ArrayBuffer>)
    visualAnalyser.getByteTimeDomainData(timeDomainData as Uint8Array<ArrayBuffer>)

    const len = frequencyData.length
    const kickEnd = 7
    const vocalEnd = Math.min(len, 140)
    const midEnd = Math.min(len, 280)

    let bKick = 0, mInst = 0, tHigh = 0, voc = 0, rms = 0
    for (let i = 0; i < kickEnd; i++) bKick += frequencyData[i] / 255
    for (let i = kickEnd; i < vocalEnd; i++) voc += frequencyData[i] / 255
    for (let i = vocalEnd; i < midEnd; i++) mInst += frequencyData[i] / 255
    for (let i = midEnd; i < len; i++) tHigh += frequencyData[i] / 255
    for (let j = 0; j < timeDomainData.length; j++) {
      const tv = (timeDomainData[j] - 128) / 128
      rms += tv * tv
    }
    bKick /= kickEnd
    voc /= vocalEnd - kickEnd
    mInst /= Math.max(1, midEnd - vocalEnd)
    tHigh /= Math.max(1, len - midEnd)
    rms = Math.sqrt(rms / timeDomainData.length)

    // 动态峰值跟踪
    bassPeak = Math.max(bassPeak * 0.994, bKick, 0.03)
    midPeak = Math.max(midPeak * 0.993, mInst, 0.026)
    treblePeak = Math.max(treblePeak * 0.992, tHigh, 0.018)
    energyPeak = Math.max(energyPeak * 0.995, rms, 0.03)

    const rb = Math.min(1, Math.pow(bKick / Math.max(0.038, bassPeak * 0.66), 0.78))
    const rm = Math.min(1, Math.pow(mInst / Math.max(0.025, midPeak * 0.7), 0.86))
    const rt = Math.min(1, Math.pow(tHigh / Math.max(0.02, treblePeak * 0.74), 0.92))
    const re = Math.min(1, Math.pow(rms / Math.max(0.034, energyPeak * 0.68), 0.82))

    const bassOnset = Math.max(0, rb - smoothBass)
    prevEnergy = prevEnergy * 0.88 + re * 0.12

    // 节拍引擎
    const beat = processBeatEngine(dt)
    if (beat.hit) {
      scheduleBeatCamera(beat.strength, beat.low)
      const rtPulse = Math.min(0.62, beat.strength * 0.68)
      if (rtPulse > beatPulse + 0.09) {
        triggerRipple((Math.random() - 0.5) * 2.0, (Math.random() - 0.5) * 2.0, 0.3 + beat.strength * 0.2)
      }
      beatPulse = Math.max(beatPulse, rtPulse)
    } else if (bassOnset > 0.075 && rb > 0.32) {
      beatPulse = Math.max(beatPulse, Math.min(0.12, bassOnset * 0.18))
    }
    beatPulse *= Math.pow(0.36, dt)

    // 包络平滑
    function env(prev: number, next: number, attack: number, release: number): number {
      const k = next > prev ? attack : release
      return prev + (next - prev) * k
    }
    smoothBass = env(smoothBass, Math.min(0.82, rb * 0.78 + re * 0.025), 0.28, 0.075)
    smoothMid = env(smoothMid, Math.min(0.68, rm * 0.64 + re * 0.025), 0.18, 0.06)
    smoothTreb = env(smoothTreb, Math.min(0.56, rt * 0.54), 0.18, 0.055)
    smoothEnergy = env(smoothEnergy, Math.min(0.72, re), 0.16, 0.055)
  } else {
    smoothBass *= 0.91
    smoothMid *= 0.91
    smoothTreb *= 0.91
    smoothEnergy *= 0.91
    beatPulse *= 0.82
  }

  // === 最终音频值 ===
  audioEnergy = Math.max(smoothEnergy, beatPulse * 0.3)
  bass = Math.min(0.9, smoothBass * 1.05 + beatPulse * 0.18) * fx.intensity
  mid = Math.min(0.72, smoothMid * 1.12) * fx.intensity
  treble = Math.min(0.62, smoothTreb * 1.2) * fx.intensity

  // 黑胶/壁纸预设的音频映射
  if (fx.preset >= 4) {
    const wallpaperAudio = fx.preset === 5
    const ringBass = smoothBass * (wallpaperAudio ? 1.1 : 1.58) + beatPulse * (wallpaperAudio ? 0.18 : 0.42) - smoothMid * 0.16 - smoothTreb * 0.06
    const ringMid = smoothMid * (wallpaperAudio ? 1.16 : 1.82) - smoothBass * 0.14 - smoothTreb * 0.07
    const ringTreble = smoothTreb * (wallpaperAudio ? 1.34 : 2.28) - smoothMid * 0.1 - smoothBass * 0.05
    bass = Math.pow(clamp01((ringBass - 0.05) / 0.58), 0.72) * fx.intensity
    mid = Math.pow(clamp01((ringMid - 0.045) / 0.46), 0.78) * fx.intensity
    treble = Math.pow(clamp01((ringTreble - 0.03) / 0.34), 0.84) * fx.intensity
    if (wallpaperAudio) {
      bass = Math.min(bass, 0.46 * fx.intensity)
      mid = Math.min(mid, 0.4 * fx.intensity)
      treble = Math.min(treble, 0.36 * fx.intensity)
      beatPulse *= 0.34
    }
  }

  // === Vinyl 旋转 ===
  const vinylSpeedMul = Math.max(0.05, fx.speed)
  const vinylSpinSpeed = (0.4 + smoothBass * 0.09) * vinylSpeedMul
  uniforms.uVinylSpin.value = (uniforms.uVinylSpin.value + dt * vinylSpinSpeed) % (Math.PI * 2)

  // === 写入 uniforms ===
  uniforms.uBass.value = bass
  uniforms.uMid.value = mid
  uniforms.uTreble.value = treble
  uniforms.uBeat.value = beatPulse
  uniforms.uEnergy.value = audioEnergy
  uniforms.uBurstAmt.value *= 0.9

  // === 转场 ===
  tickPresetTransition()

  // === 封面渐变 ===
  if (uniforms.uColorMixT.value < 1.0) {
    uniforms.uColorMixT.value += (1.0 - uniforms.uColorMixT.value) * 0.04
  }

  // === 透明度淡入 ===
  if (uniforms.uAlpha.value < 1.0) {
    uniforms.uAlpha.value += (1.0 - uniforms.uAlpha.value) * 0.05
  }

  // === 涟漪 ===
  updateRipples(dt)

  // === 相机 ===
  updateCinema(dt)
  updateCamera()

  // === 粒子旋转 (轻微跟随) ===
  if (particles) {
    particles.rotation.y += (0 - particles.rotation.y) * 0.02
    if (bloomParticles) bloomParticles.rotation.copy(particles.rotation)
  }

  // === 骷髅粒子层 (预设6) ===
  updateSkullLayer(dt)

  // === 浮空粒子层 ===
  if (!floatGroup) createFloatLayer()
  updateFloatLayer(dt)

  // === 渲染 ===
  renderer.render(scene, camera)
}

// ============================================================
//  尺寸调整
// ============================================================
function handleResize() {
  if (!renderer || !camera || !containerRef.value) return
  const w = containerRef.value.clientWidth || window.innerWidth
  const h = containerRef.value.clientHeight || window.innerHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  uniforms.uPixel.value = renderer.getPixelRatio()
}

// ============================================================
//  启停控制
// ============================================================
function start() {
  if (rafId) return
  prevTime = performance.now()
  animate()
}

function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

// ============================================================
//  Watch
// ============================================================
// 显示状态
watch(
  () => props.show,
  (show) => {
    if (show) start()
    else stop()
  }
)

// 封面变化
watch(
  () => player.value.cover,
  (url) => {
    loadCover(url)
  }
)

// 音频元素变化 (双槽翻转)
watch(
  () => Audio.value.audio,
  (newEl, oldEl) => {
    if (!newEl || newEl === oldEl) return
    cleanupAudio()
    initAudio()
  }
)

// 播放状态
watch(
  () => Audio.value.isPlay,
  () => {
    // 播放/暂停时重置预热
    if (Audio.value.isPlay) {
      rtBeat.warmupUntil = (Audio.value.audio?.currentTime || 0) + 1.5
      rtBeat.primedFrames = 0
    }
  }
)

// === fxStore → 引擎接线 ===
// 预设切换 (FxConsole 写入 fxStore.preset, 此处应用转场与相机基线)
watch(
  () => fxStore.preset,
  (p) => {
    if (p === currentPreset) return
    applyPresetToEngine(p)
  }
)

// 运动类参数 → 直接写 uniforms
watch(
  () => [
    fxStore.intensity, fxStore.depth, fxStore.point, fxStore.speed,
    fxStore.twist, fxStore.color, fxStore.scatter, fxStore.bgFade,
    fxStore.coverRes, fxStore.bloom, fxStore.bloomStrength,
    fxStore.edge
  ],
  () => syncFxUniforms()
)

// 电影镜头开关/晃动幅度
watch(
  () => [fxStore.cinema, fxStore.cinemaShake],
  () => {
    // cinemaShake 由 animate 读取 fx.cinemaShake, 这里只需确保开关即时生效
    if (!fxStore.cinema) {
      camPunch = 0
    }
  }
)

// 视觉染色参数
watch(
  () => [fxStore.tintColor, fxStore.tintStrength, fxStore.tintAuto],
  () => updateTintFromCover()
)

// 封面主色变化 (tintAuto 跟随)
watch(
  () => player.value.coverDetail?.mainColor,
  () => updateTintFromCover()
)

// ============================================================
//  生命周期
// ============================================================
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  initThree()
  initParticles()
  syncFxUniforms()
  // 应用初始预设 (无转场, 仅设置 uniforms/相机基线)
  applyPresetToEngine(fxStore.preset, { transition: false })
  updateTintFromCover()
  initAudio()
  loadCover(player.value.cover || undefined)
  handleResize()

  resizeObserver = new ResizeObserver(() => handleResize())
  if (containerRef.value) resizeObserver.observe(containerRef.value)

  if (props.show) start()
})

onBeforeUnmount(() => {
  disposed = true
  stop()
  cleanupAudio()
  resizeObserver?.disconnect()

  // 清理 Three.js 资源
  if (geometry) geometry.dispose()
  if (material) material.dispose()
  if (bloomMaterial) bloomMaterial.dispose()
  if (dotTexture) dotTexture.dispose()
  if (coverTex) coverTex.dispose()
  if (prevCoverTex) prevCoverTex.dispose()
  if (coverEdgeTex) coverEdgeTex.dispose()
  if (rippleTex) rippleTex.dispose()
  // 骷髅粒子清理
  if (skullGroup) {
    skullGroup.geometry.dispose()
    scene?.remove(skullGroup)
    skullGroup = null
  }
  if (skullMaterial) skullMaterial.dispose()
  // 浮空粒子清理
  if (floatGroup) {
    floatGroup.geometry.dispose()
    scene?.remove(floatGroup)
    floatGroup = null
  }
  if (floatMaterial) floatMaterial.dispose()
  if (renderer) {
    renderer.dispose()
    renderer.domElement?.parentNode?.removeChild(renderer.domElement)
  }
})
</script>

<style scoped>
.particle-bg-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
}

.particle-bg-container :deep(canvas) {
  display: block;
}
</style>
