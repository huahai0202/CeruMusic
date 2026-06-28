<!--
  LyricStage.vue
  3D 歌词舞台组件 — 移植自 Mineradio 项目的 stageLyrics 系统

  核心功能:
  - Three.js 场景中渲染 3D 歌词文本 (CanvasTexture 方案)
  - 星河粒子 (420 点, 5 车道流动 + 闪烁)
  - 火花粒子 (132 点, 环绕歌词)
  - 节拍驱动 (bass / beatPulse, 阳光溢光 + 光晕跟拍)
  - 歌词同步 (卡拉OK进度填充, 切行淡入淡出)
  - 多层渲染 (sun 底光 / glow 光晕 / readability 描边 / text 文本 / sparks 火花)

  接入方式:
  - 从 ControlAudioStore 获取音频元素与播放状态
  - 通过 audioManager.createAnalyser() 获取频谱数据
  - 从 GlobalPlayStatusStore 获取歌词数据
  - 由 playSetting.getParticleBg 控制背景开关
-->
<template>
  <div ref="containerRef" class="lyric-stage-container"></div>
</template>

<script lang="ts" setup>
import * as THREE from 'three'
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { playSetting } from '@renderer/store/playSetting'
import { useMineradioFxStore } from '@renderer/store/mineradioFx'
import audioManager from '@renderer/utils/audio/audioManager'
import {
  starRiverVertexShader,
  starRiverFragmentShader,
  lyricTextVertexShader,
  lyricTextFragmentShader,
  sparkVertexShader,
  sparkFragmentShader
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
const playSettingStore = playSetting()
const fxStore = useMineradioFxStore()

// ============================================================
//  类型定义
// ============================================================
interface LyricMaskResult {
  texture: THREE.CanvasTexture
  textMin: number
  textMax: number
  textWidth: number
  textHeight: number
  width: number
  height: number
  canvas: HTMLCanvasElement
}

interface LyricMeshEntry {
  group: THREE.Group
  sunMesh: THREE.Mesh
  glowMesh: THREE.Mesh
  readabilityMesh: THREE.Mesh
  textMesh: THREE.Mesh
  sparks: THREE.Points
  textMat: THREE.ShaderMaterial
  sunMat: THREE.MeshBasicMaterial
  glowMat: THREE.MeshBasicMaterial
  readabilityMat: THREE.MeshBasicMaterial
  sparkMat: THREE.ShaderMaterial
  geometries: THREE.BufferGeometry[]
  textures: THREE.Texture[]
  fading: boolean
  fadeOpacity: number
  lineStart: number
  lineEnd: number
  isFallback: boolean
}

interface NormalizedLyric {
  time: number
  endTime: number
  text: string
}

// ============================================================
//  常量
// ============================================================
const BASE_FOV = 55
const CAMERA_BASE_Z = 4.2
const WORLD_W = 6.1
const STAR_RIVER_COUNT = 420
const SPARK_COUNT = 132
const MASK_W = 2048
const MASK_H = 384

// ============================================================
//  Three.js 状态
// ============================================================
const containerRef = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let rafId = 0
let prevTime = 0
let disposed = false

// 星河粒子
let starRiver: THREE.Points | null = null
let starRiverGeo: THREE.BufferGeometry | null = null
let starRiverMat: THREE.ShaderMaterial | null = null
let starRiverDotTex: THREE.CanvasTexture | null = null

// 歌词 mesh
let activeEntry: LyricMeshEntry | null = null
const fadingEntries: LyricMeshEntry[] = []

// 歌词数据
let normalizedLyrics: NormalizedLyric[] = []
let fallbackMode = false
let fallbackText = ''
let currentLyricIdx = -1

// 音频分析器
const analyserId = `lyric-stage-${Date.now()}-${Math.random()}`
let analyser: AnalyserNode | null = null
let frequencyData: Uint8Array | null = null

// 频谱平滑值
let smoothBass = 0
let bass = 0
let bassPeak = 0.03
let beatPulse = 0

// 节拍相机
const beatCam = {
  punch: 0,
  thetaKick: 0,
  phiKick: 0,
  rollKick: 0,
  lastAt: -10,
  minInterval: 0.35
}

// 全局时间
let globalTime = 0

// ============================================================
//  工具函数
// ============================================================
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
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
//  歌词遮罩纹理 (白色文字 CanvasTexture)
// ============================================================
function makeLyricMask(text: string): LyricMaskResult {
  const W = MASK_W
  const H = MASK_H
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!

  // 自适应字体大小: 128px 起步, 下探到 42px
  let fontSize = 128
  const minFontSize = 42
  const maxWidth = W * 0.92
  const fontFamily = '"PingFang SC", "Microsoft YaHei", "HarmonyOS Sans SC", sans-serif'

  ctx.font = `bold ${fontSize}px ${fontFamily}`
  let metrics = ctx.measureText(text)

  while (metrics.width > maxWidth && fontSize > minFontSize) {
    fontSize -= 2
    ctx.font = `bold ${fontSize}px ${fontFamily}`
    metrics = ctx.measureText(text)
  }

  // 居中绘制白色文字
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, W / 2, H / 2)

  // 计算文字在 UV.x 上的起止归一化坐标
  const textWidth = metrics.width
  const textStartX = W / 2 - textWidth / 2
  const textEndX = W / 2 + textWidth / 2
  const textMin = textStartX / W
  const textMax = textEndX / W

  const texture = new THREE.CanvasTexture(cv)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true

  return {
    texture,
    textMin,
    textMax,
    textWidth,
    textHeight: fontSize,
    width: W,
    height: H,
    canvas: cv
  }
}

// ============================================================
//  歌词光晕纹理 (多级高斯模糊)
// ============================================================
function makeLyricGlowTexture(mask: LyricMaskResult): THREE.CanvasTexture {
  const W = mask.width
  const H = mask.height
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!

  // 多级高斯模糊叠加
  const blurLevels = [4, 8, 16, 26]
  ctx.globalCompositeOperation = 'lighter'
  for (const blur of blurLevels) {
    ctx.filter = `blur(${blur}px)`
    ctx.drawImage(mask.canvas, 0, 0)
  }
  ctx.filter = 'none'
  ctx.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(cv)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

// ============================================================
//  阳光底纹理 (椭圆径向渐变)
// ============================================================
function getLyricSunBloomTexture(): THREE.CanvasTexture {
  const W = 512
  const H = 256
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!

  const cx = W / 2
  const cy = H / 2

  // 椭圆径向渐变 (宽 > 高, 形成横向椭圆)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1.0, 0.5)
  ctx.translate(-cx, -cy)

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, W / 2)
  g.addColorStop(0.0, 'rgba(255,225,160,0.92)')
  g.addColorStop(0.18, 'rgba(255,195,100,0.62)')
  g.addColorStop(0.40, 'rgba(255,155,50,0.32)')
  g.addColorStop(0.68, 'rgba(255,120,20,0.12)')
  g.addColorStop(1.0, 'rgba(255,100,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.restore()

  const texture = new THREE.CanvasTexture(cv)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

// ============================================================
//  可读性描边纹理 (模糊黑色描边)
// ============================================================
function makeLyricReadabilityTexture(mask: LyricMaskResult): THREE.CanvasTexture {
  const W = mask.width
  const H = mask.height
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!

  // 绘制模糊的文字形状
  ctx.filter = 'blur(5px)'
  ctx.drawImage(mask.canvas, 0, 0)
  ctx.filter = 'none'

  // 将白色转为半透明黑色 (形成深色描边)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'

  const texture = new THREE.CanvasTexture(cv)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

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
  camera.position.set(0, 0, CAMERA_BASE_Z)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    powerPreference: 'high-performance'
  })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.setClearColor(0x000000, 0)
  renderer.autoClear = true

  const canvas = renderer.domElement
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.zIndex = '0'
  canvas.style.pointerEvents = 'none'
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  containerRef.value.appendChild(canvas)
}

// ============================================================
//  初始化星河粒子
// ============================================================
function initStarRiver() {
  if (!scene || !renderer) return

  starRiverDotTex = makeDotTexture()

  const count = STAR_RIVER_COUNT
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const lanes = new Float32Array(count)
  const depthSeeds = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    positions[i * 3] = 0
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = 0
    seeds[i] = Math.random()
    lanes[i] = Math.random()
    depthSeeds[i] = Math.random()
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1))
  geo.setAttribute('lane', new THREE.BufferAttribute(lanes, 1))
  geo.setAttribute('depthSeed', new THREE.BufferAttribute(depthSeeds, 1))

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: starRiverDotTex },
      uTime: { value: 0 },
      uPixel: { value: renderer.getPixelRatio() },
      uBass: { value: 0 },
      uBeat: { value: 0 },
      uWidth: { value: 4.2 },
      uHeight: { value: 0.58 },
      uOpacity: { value: 0 },
      uColorA: { value: new THREE.Color('#5b8def') },
      uColorB: { value: new THREE.Color('#b07ce8') }
    },
    vertexShader: starRiverVertexShader,
    fragmentShader: starRiverFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  })

  starRiver = new THREE.Points(geo, mat)
  starRiver.position.set(0, 0.2, 1.53)
  starRiver.renderOrder = 45
  starRiver.frustumCulled = false
  scene.add(starRiver)

  starRiverGeo = geo
  starRiverMat = mat
}

// ============================================================
//  构建歌词 mesh (5 层 Group)
// ============================================================
function buildLyricMesh(
  text: string,
  lineStart: number,
  lineEnd: number,
  isFallback: boolean
): LyricMeshEntry {
  const mask = makeLyricMask(text)
  const glowTex = makeLyricGlowTexture(mask)
  const sunTex = getLyricSunBloomTexture()
  const readabilityTex = makeLyricReadabilityTexture(mask)
  const sparkDotTex = makeDotTexture()

  const worldW = WORLD_W
  const worldH = worldW * (mask.height / mask.width)

  const group = new THREE.Group()
  const geometries: THREE.BufferGeometry[] = []
  const textures: THREE.Texture[] = [mask.texture, glowTex, sunTex, readabilityTex, sparkDotTex]

  // --- sun (renderOrder 40): 椭圆径向渐变阳光底 ---
  const sunGeo = new THREE.PlaneGeometry(worldW * 1.6, worldH * 2.4)
  geometries.push(sunGeo)
  const sunMat = new THREE.MeshBasicMaterial({
    map: sunTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    opacity: 0
  })
  const sunMesh = new THREE.Mesh(sunGeo, sunMat)
  sunMesh.renderOrder = 40
  group.add(sunMesh)

  // --- glow (renderOrder 41): 多级模糊光晕 ---
  const glowGeo = new THREE.PlaneGeometry(worldW, worldH)
  geometries.push(glowGeo)
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    opacity: 0
  })
  const glowMesh = new THREE.Mesh(glowGeo, glowMat)
  glowMesh.renderOrder = 41
  group.add(glowMesh)

  // --- readability (renderOrder 42): 黑色描边 ---
  const readGeo = new THREE.PlaneGeometry(worldW, worldH)
  geometries.push(readGeo)
  const readabilityMat = new THREE.MeshBasicMaterial({
    map: readabilityTex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    opacity: 0
  })
  const readabilityMesh = new THREE.Mesh(readGeo, readabilityMat)
  readabilityMesh.renderOrder = 42
  group.add(readabilityMesh)

  // --- textMesh (renderOrder 43): 卡拉OK进度填充 ---
  const textGeo = new THREE.PlaneGeometry(worldW, worldH)
  geometries.push(textGeo)
  const textMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: mask.texture },
      uProgress: { value: isFallback ? 1 : 0 },
      uTextMin: { value: mask.textMin },
      uTextMax: { value: mask.textMax },
      uOpacity: { value: 0 },
      uFeather: { value: 0.055 },
      uSolar: { value: 0 },
      uBaseColor: { value: new THREE.Color(fxStore.lyricBaseColor) },
      uHiColor: { value: new THREE.Color(fxStore.lyricHiColor) },
      uGlowColor: { value: new THREE.Color(fxStore.lyricGlowColor) },
      uSolarColor: { value: new THREE.Color(fxStore.lyricSolarColor) }
    },
    vertexShader: lyricTextVertexShader,
    fragmentShader: lyricTextFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false
  })
  const textMesh = new THREE.Mesh(textGeo, textMat)
  textMesh.renderOrder = 43
  group.add(textMesh)

  // --- sparks (renderOrder 44): 132 个环绕火花 ---
  const sparkGeo = new THREE.BufferGeometry()
  geometries.push(sparkGeo)
  const sparkPositions = new Float32Array(SPARK_COUNT * 3)
  const sparkSeeds = new Float32Array(SPARK_COUNT)
  for (let i = 0; i < SPARK_COUNT; i++) {
    // 在文字周围椭圆区域分布
    const angle = Math.random() * Math.PI * 2
    const radius = 0.4 + Math.random() * 0.6
    sparkPositions[i * 3] = (Math.random() - 0.5) * worldW * 1.1
    sparkPositions[i * 3 + 1] =
      (Math.random() - 0.5) * worldH * 2.2 +
      Math.sin(angle) * radius * worldH * 0.5
    sparkPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.3
    sparkSeeds[i] = Math.random()
  }
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3))
  sparkGeo.setAttribute('seed', new THREE.BufferAttribute(sparkSeeds, 1))

  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: sparkDotTex },
      uColor: { value: new THREE.Color(fxStore.lyricSparkColor) },
      uOpacity: { value: 0 },
      uSize: { value: 0.045 },
      uPixel: { value: renderer ? renderer.getPixelRatio() : 1 }
    },
    vertexShader: sparkVertexShader,
    fragmentShader: sparkFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  })
  const sparks = new THREE.Points(sparkGeo, sparkMat)
  sparks.renderOrder = 44
  sparks.frustumCulled = false
  group.add(sparks)

  return {
    group,
    sunMesh,
    glowMesh,
    readabilityMesh,
    textMesh,
    sparks,
    textMat,
    sunMat,
    glowMat,
    readabilityMat,
    sparkMat,
    geometries,
    textures,
    fading: false,
    fadeOpacity: 0,
    lineStart,
    lineEnd,
    isFallback
  }
}

// ============================================================
//  显示歌词行 (创建新 mesh, 旧 mesh 淡出)
// ============================================================
function showStageLine(text: string, lineStart: number, lineEnd: number, isFallback: boolean) {
  if (!scene) return

  // 旧 mesh 标记淡出
  if (activeEntry) {
    activeEntry.fading = true
    fadingEntries.push(activeEntry)
  }

  // 创建新 mesh
  const entry = buildLyricMesh(text, lineStart, lineEnd, isFallback)
  scene.add(entry.group)
  activeEntry = entry
}

// ============================================================
//  清理歌词 mesh 资源
// ============================================================
function disposeLyricEntry(entry: LyricMeshEntry) {
  for (const geo of entry.geometries) {
    geo.dispose()
  }
  entry.textMat.dispose()
  entry.sunMat.dispose()
  entry.glowMat.dispose()
  entry.readabilityMat.dispose()
  entry.sparkMat.dispose()
  for (const tex of entry.textures) {
    tex.dispose()
  }
}

// ============================================================
//  清除所有歌词 mesh
// ============================================================
function clearAllLyricMeshes() {
  if (activeEntry && scene) {
    scene.remove(activeEntry.group)
    disposeLyricEntry(activeEntry)
    activeEntry = null
  }
  for (const entry of fadingEntries) {
    if (scene) scene.remove(entry.group)
    disposeLyricEntry(entry)
  }
  fadingEntries.length = 0
}

// ============================================================
//  歌词数据归一化
// ============================================================
function normalizeLyrics(lines: any[]): NormalizedLyric[] {
  const result: NormalizedLyric[] = []
  for (const line of lines) {
    let text = ''

    // 提取文字 (兼容 words / text / lyric / content 字段)
    if (Array.isArray(line.words) && line.words.length > 0) {
      text = line.words.map((w: any) => w.word || '').join('')
    } else if (typeof line.text === 'string') {
      text = line.text
    } else if (typeof line.lyric === 'string') {
      text = line.lyric
    } else if (typeof line.content === 'string') {
      text = line.content
    }

    // 跳过空行 / 纯乐器行
    if (!text || !text.trim() || text.trim() === '//') continue

    // 提取起始时间 (LyricLine.startTime 为 ms, fallback time 为秒)
    let startTime: number | null = null
    if (typeof line.startTime === 'number') {
      startTime = line.startTime / 1000
    } else if (typeof line.time === 'number') {
      startTime = line.time
    }
    if (startTime === null) continue

    // 提取结束时间
    const endTime: number =
      typeof line.endTime === 'number' ? line.endTime / 1000 : startTime + 5

    result.push({ time: startTime, endTime, text: text.trim() })
  }
  return result
}

// ============================================================
//  歌词同步 (每帧扫描歌词数组, 找当前行)
// ============================================================
function tickLyrics() {
  const currentTime = Audio.value.currentTime || 0

  if (fallbackMode) {
    // 无歌词: 显示歌名 fallback
    if (!activeEntry && fallbackText) {
      showStageLine(fallbackText, 0, 999999, true)
    }
    return
  }

  // 二分查找当前行
  let newIdx = -1
  for (let i = 0; i < normalizedLyrics.length; i++) {
    if (normalizedLyrics[i].time <= currentTime) {
      newIdx = i
    } else {
      break
    }
  }

  // 切行
  if (newIdx !== currentLyricIdx && newIdx >= 0) {
    currentLyricIdx = newIdx
    const line = normalizedLyrics[newIdx]
    showStageLine(line.text, line.time, line.endTime, false)
  } else if (newIdx < 0 && currentLyricIdx !== -1) {
    // 回到歌曲开头前, 清除当前行
    currentLyricIdx = -1
  }

  // 更新卡拉OK进度
  if (activeEntry && !activeEntry.isFallback && currentLyricIdx >= 0) {
    const line = normalizedLyrics[currentLyricIdx]
    const duration = line.endTime - line.time
    const progress = duration > 0 ? clamp01((currentTime - line.time) / duration) : 1
    activeEntry.textMat.uniforms.uProgress.value = progress
  }
}

// ============================================================
//  音频分析 (频谱提取 + 节拍检测)
// ============================================================
function updateAudio(dt: number) {
  const playing = Audio.value.isPlay && Audio.value.audio && !Audio.value.audio.paused

  if (!analyser || !frequencyData || !playing) {
    smoothBass *= 0.9
    bass *= 0.9
    beatPulse *= 0.85
    decayBeatCam(dt)
    return
  }

  analyser.getByteFrequencyData(frequencyData as Uint8Array<ArrayBuffer>)

  // Bass 频段: 前 8 个 bin
  const bassEnd = Math.min(8, frequencyData.length)
  let bSum = 0
  for (let i = 0; i < bassEnd; i++) {
    bSum += frequencyData[i] / 255
  }
  const bAvg = bSum / bassEnd

  // 动态峰值跟踪
  bassPeak = Math.max(bassPeak * 0.994, bAvg, 0.03)
  const bassNorm = Math.min(1, Math.pow(bAvg / Math.max(0.038, bassPeak * 0.66), 0.78))

  // 节拍检测 (简化 onset)
  const bassOnset = Math.max(0, bassNorm - smoothBass)
  if (bassOnset > 0.12 && bassNorm > 0.35) {
    const now = Audio.value.currentTime || 0
    if (now - beatCam.lastAt > beatCam.minInterval) {
      beatCam.lastAt = now
      const strength = Math.min(0.8, bassOnset * 1.5 + 0.2)
      beatPulse = Math.max(beatPulse, strength)
      beatCam.punch = Math.max(beatCam.punch, strength * 0.5)
      beatCam.thetaKick = (Math.random() - 0.5) * strength * 0.08
      beatCam.phiKick = (Math.random() - 0.5) * strength * 0.06
      beatCam.rollKick = (Math.random() - 0.5) * strength * 0.04
    }
  }

  // 包络平滑
  const attackK = bassNorm > smoothBass ? 0.28 : 0.075
  smoothBass += (bassNorm - smoothBass) * attackK
  bass = Math.min(0.9, smoothBass * 0.85)
  beatPulse *= Math.pow(0.36, dt)

  decayBeatCam(dt)
}

function decayBeatCam(dt: number) {
  const decay = Math.pow(0.3, dt)
  beatCam.punch *= decay
  beatCam.thetaKick *= decay
  beatCam.phiKick *= decay
  beatCam.rollKick *= decay
}

// ============================================================
//  更新歌词 mesh (节拍驱动效果)
// ============================================================
function updateLyricMeshes() {
  const glowBreath = 0.5 + 0.5 * Math.sin(globalTime * 0.7)
  const musicBloom = bass * 0.8
  const beatGlow = beatPulse
  const solarBloom = 0.18 + glowBreath * 0.16 + musicBloom * 0.9 + beatGlow * 1.18
  const highBloom = clamp01(solarBloom * 0.6)

  // fxStore 歌词舞台参数 (每帧读取保证即时生效)
  const glowMul = Math.max(0, fxStore.lyricGlow)
  const scaleMul = Math.max(0.2, fxStore.lyricScale)
  const posX = fxStore.lyricX
  const posY = fxStore.lyricY

  // 光晕跟拍偏移
  const glowFollowX = beatCam.thetaKick * 0.15
  const glowFollowY = -beatCam.phiKick * 0.15

  // 更新活跃 mesh
  if (activeEntry) {
    const targetOpacity = 1
    activeEntry.fadeOpacity += (targetOpacity - activeEntry.fadeOpacity) * 0.08

    const op = activeEntry.fadeOpacity
    activeEntry.sunMat.opacity = solarBloom * op
    activeEntry.glowMat.opacity = (0.3 + highBloom * 0.5) * op * glowMul * 2
    activeEntry.readabilityMat.opacity = 0.6 * op
    activeEntry.textMat.uniforms.uOpacity.value = op
    activeEntry.textMat.uniforms.uSolar.value = solarBloom * 0.5
    activeEntry.sparkMat.uniforms.uOpacity.value = (0.4 + highBloom * 0.4) * op

    // 光晕跟拍偏移
    activeEntry.glowMesh.position.x = glowFollowX
    activeEntry.glowMesh.position.y = glowFollowY
    activeEntry.sunMesh.position.x = glowFollowX * 0.6
    activeEntry.sunMesh.position.y = glowFollowY * 0.6

    // 歌词位置 (用户自定义 + 跟拍偏移)
    activeEntry.group.position.x = posX
    activeEntry.group.position.y = posY

    // 节拍缩放 × fx.lyricScale
    const scale = (1 + beatPulse * 0.04) * scaleMul
    activeEntry.group.scale.setScalar(scale)
  }

  // 更新淡出 mesh
  for (let i = fadingEntries.length - 1; i >= 0; i--) {
    const entry = fadingEntries[i]
    entry.fadeOpacity -= 0.045
    if (entry.fadeOpacity <= 0) {
      if (scene) scene.remove(entry.group)
      disposeLyricEntry(entry)
      fadingEntries.splice(i, 1)
    } else {
      const op = entry.fadeOpacity
      entry.sunMat.opacity = solarBloom * op * 0.5
      entry.glowMat.opacity = (0.3 + highBloom * 0.5) * op * 0.5 * glowMul * 2
      entry.readabilityMat.opacity = 0.6 * op * 0.5
      entry.textMat.uniforms.uOpacity.value = op * 0.5
      entry.sparkMat.uniforms.uOpacity.value = (0.4 + highBloom * 0.4) * op * 0.5

      // 淡出时缩小
      const scale = (1 + beatPulse * 0.04 - (1 - op) * 0.1) * scaleMul
      entry.group.scale.setScalar(Math.max(0.1, scale))
    }
  }
}

// ============================================================
//  应用歌词色彩 (fxStore 颜色变化时调用, 不重建 mesh)
// ============================================================
function applyLyricColors() {
  const targets: LyricMeshEntry[] = []
  if (activeEntry) targets.push(activeEntry)
  for (const e of fadingEntries) targets.push(e)
  for (const entry of targets) {
    entry.textMat.uniforms.uBaseColor.value.set(fxStore.lyricBaseColor)
    entry.textMat.uniforms.uHiColor.value.set(fxStore.lyricHiColor)
    entry.textMat.uniforms.uGlowColor.value.set(fxStore.lyricGlowColor)
    entry.textMat.uniforms.uSolarColor.value.set(fxStore.lyricSolarColor)
    entry.sparkMat.uniforms.uColor.value.set(fxStore.lyricSparkColor)
  }
}

// ============================================================
//  相机更新 (轻微节拍驱动)
// ============================================================
function updateCamera() {
  if (!camera) return

  const targetZ = CAMERA_BASE_Z - beatCam.punch * 0.15
  const targetX = beatCam.thetaKick * 0.3
  const targetY = -beatCam.phiKick * 0.3

  camera.position.x += (targetX - camera.position.x) * 0.1
  camera.position.y += (targetY - camera.position.y) * 0.1
  camera.position.z += (targetZ - camera.position.z) * 0.1
  camera.lookAt(0, 0, 0)
  camera.rotation.z += beatCam.rollKick * 0.1
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
  globalTime += dt

  // 音频分析
  updateAudio(dt)

  // 星河粒子 uniforms
  if (starRiverMat) {
    starRiverMat.uniforms.uTime.value = globalTime
    starRiverMat.uniforms.uBass.value = bass
    starRiverMat.uniforms.uBeat.value = beatPulse
    // 透明度: 受粒子背景开关控制, 淡入/淡出
    const targetOpacity = playSettingStore.getParticleBg ? 1 : 0
    starRiverMat.uniforms.uOpacity.value +=
      (targetOpacity - starRiverMat.uniforms.uOpacity.value) * 0.04
  }

  // 歌词同步
  tickLyrics()

  // 歌词 mesh 更新
  updateLyricMeshes()

  // 相机
  updateCamera()

  // 渲染
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

  const pixelRatio = renderer.getPixelRatio()
  if (starRiverMat) {
    starRiverMat.uniforms.uPixel.value = pixelRatio
  }
  if (activeEntry) {
    activeEntry.sparkMat.uniforms.uPixel.value = pixelRatio
  }
}

// ============================================================
//  音频分析器初始化
// ============================================================
function initAudio() {
  const audioEl = Audio.value.audio
  if (!audioEl) return

  try {
    analyser = audioManager.createAnalyser(audioEl, analyserId, 2048)
    if (analyser) {
      frequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    }
  } catch (e) {
    console.error('LyricStage: 音频分析器初始化失败', e)
  }
}

function cleanupAudio() {
  try {
    audioManager.removeAnalyser(analyserId)
  } catch {}
  analyser = null
  frequencyData = null
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
//  Watch: 显示状态
// ============================================================
watch(
  () => props.show,
  (show) => {
    if (show) {
      start()
    } else {
      stop()
    }
  }
)

// ============================================================
//  Watch: 歌词数据变化
// ============================================================
watch(
  () => player.value.lyrics.lines,
  (lines) => {
    normalizedLyrics = normalizeLyrics(lines || [])
    fallbackMode = normalizedLyrics.length === 0
    if (fallbackMode) {
      fallbackText =
        (player.value.songInfo as any)?.name || 'CeruMusic'
    }
    currentLyricIdx = -1
    clearAllLyricMeshes()
  },
  { immediate: true }
)

// ============================================================
//  Watch: 歌名变化 (fallback 模式更新)
// ============================================================
watch(
  () => (player.value.songInfo as any)?.name,
  (name) => {
    if (fallbackMode) {
      fallbackText = name || 'CeruMusic'
      // 如果当前显示的是 fallback, 重建
      if (activeEntry && activeEntry.isFallback) {
        clearAllLyricMeshes()
      }
    }
  }
)

// ============================================================
//  Watch: 音频元素变化 (双槽翻转)
// ============================================================
watch(
  () => Audio.value.audio,
  (newEl, oldEl) => {
    if (!newEl || newEl === oldEl) return
    cleanupAudio()
    initAudio()
  }
)

// ============================================================
//  Watch: 播放状态 (重置节拍预热)
// ============================================================
watch(
  () => Audio.value.isPlay,
  (isPlay) => {
    if (isPlay) {
      beatCam.lastAt = -10
    }
  }
)

// ============================================================
//  Watch: fxStore 歌词色彩变化 (实时应用到已有 mesh)
// ============================================================
watch(
  () => [
    fxStore.lyricBaseColor, fxStore.lyricHiColor,
    fxStore.lyricGlowColor, fxStore.lyricSolarColor, fxStore.lyricSparkColor
  ],
  () => applyLyricColors()
)

// ============================================================
//  生命周期
// ============================================================
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  initThree()
  initStarRiver()
  initAudio()

  // 初始化歌词数据
  normalizedLyrics = normalizeLyrics(player.value.lyrics.lines || [])
  fallbackMode = normalizedLyrics.length === 0
  if (fallbackMode) {
    fallbackText = (player.value.songInfo as any)?.name || 'CeruMusic'
  }

  resizeObserver = new ResizeObserver(() => handleResize())
  if (containerRef.value) resizeObserver.observe(containerRef.value)
  handleResize()

  if (props.show) {
    start()
  }
})

onBeforeUnmount(() => {
  disposed = true
  stop()
  cleanupAudio()
  resizeObserver?.disconnect()

  // 清理歌词 mesh
  clearAllLyricMeshes()

  // 清理星河粒子
  if (starRiverGeo) starRiverGeo.dispose()
  if (starRiverMat) starRiverMat.dispose()
  if (starRiverDotTex) starRiverDotTex.dispose()

  // 清理 renderer
  if (renderer) {
    renderer.dispose()
    renderer.domElement?.parentNode?.removeChild(renderer.domElement)
  }
  renderer = null
  scene = null
  camera = null
  starRiver = null
  starRiverGeo = null
  starRiverMat = null
  starRiverDotTex = null
})
</script>

<style scoped>
.lyric-stage-container {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

.lyric-stage-container :deep(canvas) {
  display: block;
}
</style>
