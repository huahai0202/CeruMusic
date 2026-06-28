<!--
  ShelfView.vue
  3D 歌单架组件 — 移植自 Mineradio 项目的 shelfManager 系统

  核心功能:
  - Three.js PSP 风格 3D 卡片轮播歌单架 (唱片架 / side 模式)
  - 每张卡片: PlaneGeometry(2.05, 1.025) + CanvasTexture(720×360)
  - Canvas 绘制: 圆角底 / 封面图 / 标题 / 副标题 / 播放按钮
  - centerSmooth 平滑插值的居中 index, 每帧 placeCard 重排
  - 中心卡突出放大, 远处缩小淡出, 超出 SHELF_VISIBLE_RADIUS 隐藏
  - 交互: 鼠标滚轮 / 方向键滚动, Raycaster 点击 (中心卡触发 select, 否则滚动到该卡)

  数据源适配:
  - 优先使用 songListAPI.getAll() 获取用户歌单 (type:'playlist')
  - 歌单为空时回退到 LocalUserDetailStore.list 播放队列 (type:'song')
  - 封面图异步加载 (Image + drawImage), 加载完成后重绘 CanvasTexture

  接口:
  - props.show (boolean): 显示 / 隐藏 (启停动画)
  - emit('select', item): 选中中心卡时触发, 传递 { title, sub, cover, type, playlistId, raw }
-->
<template>
  <div ref="containerRef" class="shelf-container" :class="{ 'is-hidden': !show }">
    <Transition name="shelf-fade">
      <div v-if="show && focusedTitle" class="shelf-focus-info" @click.stop>
        <div class="shelf-focus-title">{{ focusedTitle }}</div>
        <div v-if="focusedSub" class="shelf-focus-sub">{{ focusedSub }}</div>
      </div>
    </Transition>
    <div class="shelf-hint">滚轮 / 方向键 切换 · 点击卡片播放</div>
  </div>
</template>

<script lang="ts" setup>
import * as THREE from 'three'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { songListAPI } from '@renderer/api/songList'
import type { SongList } from '@renderer/types/audio'
import type { SongList as PlaylistMeta } from '@common/types/songList'
import defaultCoverSrc from '@renderer/assets/images/song.jpg'

defineOptions({ name: 'ShelfView' })

// ============================================================
//  Props / Emits
// ============================================================
const props = withDefaults(
  defineProps<{
    show?: boolean
  }>(),
  { show: false }
)

const emit = defineEmits<{
  (e: 'select', item: ShelfItem): void
}>()

// ============================================================
//  Store
// ============================================================
const localUserStore = LocalUserDetailStore()
const { list } = storeToRefs(localUserStore)

// ============================================================
//  类型定义
// ============================================================
interface ShelfItem {
  title: string
  sub: string
  cover: string
  type: 'playlist' | 'song'
  playlistId: string | number
  raw: unknown
}

interface Card {
  mesh: THREE.Mesh
  geometry: THREE.PlaneGeometry
  material: THREE.MeshBasicMaterial
  texture: THREE.CanvasTexture
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  coverImg: HTMLImageElement | null
  item: ShelfItem
  curOpacity: number
  targetOpacity: number
  targetVisible: boolean
}

// ============================================================
//  常量 & 布局参数 (对应 Mineradio shelfManager)
// ============================================================
const CARD_W = 2.05
const CARD_H = 1.025
const CANVAS_W = 720
const CANVAS_H = 360
const SHELF_VISIBLE_RADIUS = 5
const FALLBACK_SONG_CAP = 60

const layout = {
  sideY: 1.2,
  sideYStep: 1.15,
  sideZStep: 0.35,
  sideRotY: 0.35,
  sideRotX: -0.12,
  centerScale: 1.15,
  farScale: 0.72,
  centerOpacity: 1.0,
  farOpacity: 0.35
}

// ============================================================
//  数据源
// ============================================================
const playlists = ref<PlaylistMeta[]>([])

const shelfItems = computed<ShelfItem[]>(() => {
  if (playlists.value.length) {
    return playlists.value.map((p) => ({
      title: p.name || '未命名歌单',
      sub: p.description || (p.source ? `来源 · ${p.source}` : '歌单'),
      cover: p.coverImgUrl,
      type: 'playlist' as const,
      playlistId: p.id,
      raw: p
    }))
  }
  return list.value.slice(0, FALLBACK_SONG_CAP).map((s: SongList) => ({
    title: s.name || '未知歌曲',
    sub: s.singer || '',
    cover: (s as { img?: string }).img || '',
    type: 'song' as const,
    playlistId: s.songmid,
    raw: s
  }))
})

// ============================================================
//  Three.js 状态
// ============================================================
const containerRef = ref<HTMLDivElement>()
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let canvasEl: HTMLCanvasElement | null = null
let maxAnisotropy = 1

const cards: Card[] = []
const coverBlobUrls: string[] = []

let centerTarget = 0
let centerSmooth = 0
let rafId = 0
let running = false
let prevTime = 0
let disposed = false
let lastSignature = ''
let lastFocusedIdx = -1
let wheelLockUntil = 0

const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
let downInfo: { x: number; y: number; t: number } | null = null
let resizeObserver: ResizeObserver | null = null

const focusedTitle = ref('')
const focusedSub = ref('')

// ============================================================
//  工具函数
// ============================================================
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (!text) return ''
  if (ctx.measureText(text).width <= maxW) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

async function resolveCoverUrl(url: string): Promise<string> {
  if (!url || url === 'default-cover' || url === 'default-cover.png') {
    return defaultCoverSrc
  }
  if (/^(data:|blob:|file:)/i.test(url)) return url
  if (/^https?:/i.test(url)) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('bad response')
      const blob = await resp.blob()
      const u = URL.createObjectURL(blob)
      coverBlobUrls.push(u)
      return u
    } catch {
      return defaultCoverSrc
    }
  }
  return url
}

// ============================================================
//  Canvas 卡片绘制
// ============================================================
function drawCard(card: Card): void {
  const { ctx, canvas, item, coverImg } = card
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  // 圆角底
  roundRectPath(ctx, 2, 2, W - 4, H - 4, 28)
  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, 'rgba(30,30,44,0.95)')
  grad.addColorStop(1, 'rgba(16,16,24,0.95)')
  ctx.fillStyle = grad
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'
  ctx.stroke()

  // 封面区
  const pad = 16
  const coverSize = H - pad * 2
  const cx = pad
  const cy = pad

  ctx.save()
  roundRectPath(ctx, cx, cy, coverSize, coverSize, 22)
  ctx.clip()
  if (coverImg && coverImg.complete && coverImg.naturalWidth > 0) {
    const iw = coverImg.naturalWidth
    const ih = coverImg.naturalHeight
    const s = Math.max(coverSize / iw, coverSize / ih)
    const dw = iw * s
    const dh = ih * s
    ctx.drawImage(coverImg, cx + (coverSize - dw) / 2, cy + (coverSize - dh) / 2, dw, dh)
  } else {
    const g = ctx.createLinearGradient(cx, cy, cx + coverSize, cy + coverSize)
    g.addColorStop(0, '#3a3a55')
    g.addColorStop(1, '#16161f')
    ctx.fillStyle = g
    ctx.fillRect(cx, cy, coverSize, coverSize)
    // 占位音符
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.font = '120px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('♪', cx + coverSize / 2, cy + coverSize / 2)
  }
  ctx.restore()
  // 封面描边
  roundRectPath(ctx, cx, cy, coverSize, coverSize, 22)
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.stroke()

  // 文本区
  const tx = cx + coverSize + 26
  const tw = W - tx - pad
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  // 标题
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 6
  ctx.fillStyle = '#ffffff'
  ctx.font = '700 46px "PingFang SC","Microsoft YaHei",sans-serif'
  ctx.fillText(ellipsis(ctx, item.title, tw), tx, cy + 22)
  ctx.shadowBlur = 0

  // 副标题
  ctx.fillStyle = 'rgba(255,255,255,0.62)'
  ctx.font = '400 30px "PingFang SC","Microsoft YaHei",sans-serif'
  ctx.fillText(ellipsis(ctx, item.sub || '', tw), tx, cy + 92)

  // 类型标签
  ctx.font = '600 24px "PingFang SC","Microsoft YaHei",sans-serif'
  ctx.fillStyle = item.type === 'playlist' ? 'rgba(120,200,255,0.95)' : 'rgba(255,206,120,0.95)'
  ctx.fillText(item.type === 'playlist' ? '歌单' : '歌曲', tx, cy + coverSize - 34)

  // 播放按钮
  const btnR = 30
  const btnX = W - pad - btnR - 12
  const btnY = H - pad - btnR - 12
  ctx.beginPath()
  ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fill()
  ctx.fillStyle = '#111118'
  ctx.beginPath()
  ctx.moveTo(btnX - 9, btnY - 13)
  ctx.lineTo(btnX + 14, btnY)
  ctx.lineTo(btnX - 9, btnY + 13)
  ctx.closePath()
  ctx.fill()

  card.texture.needsUpdate = true
}

async function loadCardCover(card: Card): Promise<void> {
  const resolved = await resolveCoverUrl(card.item.cover)
  if (disposed) return
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    if (disposed) return
    card.coverImg = img
    drawCard(card)
  }
  img.onerror = () => {
    if (disposed) return
    // 加载失败: 尝试用默认封面再绘一次
    if (resolved !== defaultCoverSrc) {
      const fb = new Image()
      fb.onload = () => {
        if (disposed) return
        card.coverImg = fb
        drawCard(card)
      }
      fb.src = defaultCoverSrc
    }
  }
  img.src = resolved
}

// ============================================================
//  卡片构建 / 销毁
// ============================================================
function disposeCard(card: Card): void {
  if (scene) scene.remove(card.mesh)
  card.geometry.dispose()
  card.material.dispose()
  card.texture.dispose()
}

function clearCards(): void {
  for (const c of cards) disposeCard(c)
  cards.length = 0
  for (const u of coverBlobUrls) URL.revokeObjectURL(u)
  coverBlobUrls.length = 0
  centerTarget = 0
  centerSmooth = 0
  lastFocusedIdx = -1
  focusedTitle.value = ''
  focusedSub.value = ''
}

function buildCards(items: ShelfItem[]): void {
  if (!scene) return
  clearCards()

  const source = items.length
    ? items
    : [
        {
          title: '暂无歌单',
          sub: '创建或导入歌单后即可在此展示',
          cover: '',
          type: 'playlist' as const,
          playlistId: '__empty__',
          raw: null
        }
      ]

  for (let i = 0; i < source.length; i++) {
    const item = source[i]
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    const ctx = canvas.getContext('2d')
    if (!ctx) continue

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = false
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = Math.min(4, maxAnisotropy)

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      opacity: 0
    })
    const geometry = new THREE.PlaneGeometry(CARD_W, CARD_H)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.index = i
    mesh.visible = false
    scene.add(mesh)

    const card: Card = {
      mesh,
      geometry,
      material,
      texture,
      canvas,
      ctx,
      coverImg: null,
      item,
      curOpacity: 0,
      targetOpacity: 0,
      targetVisible: false
    }
    cards.push(card)
    drawCard(card)
    if (item.playlistId !== '__empty__') void loadCardCover(card)
  }

  snapLayout()
}

// ============================================================
//  PSP 弧形布局 (placeCard) — side 模式
// ============================================================
function placeCard(card: Card, i: number): void {
  const delta = i - centerSmooth
  const absD = Math.abs(delta)
  const within = absD <= SHELF_VISIBLE_RADIUS
  card.targetVisible = within
  if (!within) {
    card.targetOpacity = 0
    return
  }

  const py = layout.sideY - delta * layout.sideYStep
  const pz = -absD * layout.sideZStep

  const t = Math.min(absD / SHELF_VISIBLE_RADIUS, 1)
  const scale = layout.centerScale + (layout.farScale - layout.centerScale) * t
  const opacity = layout.centerOpacity + (layout.farOpacity - layout.centerOpacity) * t

  card.mesh.position.set(0, py, pz)
  card.mesh.scale.setScalar(scale)

  // 斜切旋转: 上下两侧反向 fan-out
  const sign = delta >= 0 ? 1 : -1
  card.mesh.rotation.set(layout.sideRotX, sign * layout.sideRotY, 0)
  card.mesh.renderOrder = -absD

  card.targetOpacity = opacity
}

function snapLayout(): void {
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    placeCard(c, i)
    c.curOpacity = c.targetOpacity
    c.mesh.visible = c.curOpacity > 0.01
    c.material.opacity = c.curOpacity
  }
  updateFocusedInfo()
}

// ============================================================
//  动画循环
// ============================================================
function update(dt: number): void {
  // centerSmooth 平滑插值 (60fps 时等价 *0.16, 帧率无关化)
  const k = 1 - Math.pow(1 - 0.16, dt * 60)
  centerSmooth += (centerTarget - centerSmooth) * k

  const ok = 1 - Math.pow(1 - 0.2, dt * 60)
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    placeCard(c, i)
    c.curOpacity += (c.targetOpacity - c.curOpacity) * ok
    if (c.curOpacity < 0.01 && !c.targetVisible) {
      c.mesh.visible = false
    } else {
      c.mesh.visible = true
      c.material.opacity = c.curOpacity
    }
  }
  updateFocusedInfo()
}

function updateFocusedInfo(): void {
  const fi = Math.round(centerSmooth)
  if (fi === lastFocusedIdx) return
  lastFocusedIdx = fi
  const c = cards[fi]
  if (c) {
    focusedTitle.value = c.item.title
    focusedSub.value = c.item.sub
  } else {
    focusedTitle.value = ''
    focusedSub.value = ''
  }
}

function startAnimation(): void {
  if (running || !renderer || !scene || !camera) return
  running = true
  prevTime = performance.now()
  const loop = () => {
    if (!running) return
    rafId = requestAnimationFrame(loop)
    if (disposed || !renderer || !scene || !camera) return
    const now = performance.now()
    const dt = Math.min(0.05, (now - prevTime) / 1000)
    prevTime = now
    update(dt)
    renderer.render(scene, camera)
  }
  rafId = requestAnimationFrame(loop)
}

function stopAnimation(): void {
  running = false
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

// ============================================================
//  交互
// ============================================================
function clampCenter(): void {
  if (cards.length === 0) {
    centerTarget = 0
    return
  }
  centerTarget = clamp(centerTarget, 0, cards.length - 1)
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (performance.now() < wheelLockUntil) return
  const dir = Math.sign(e.deltaY || e.deltaX)
  if (dir === 0) return
  centerTarget += dir
  clampCenter()
  wheelLockUntil = performance.now() + 90
}

function onPointerDown(e: PointerEvent): void {
  downInfo = { x: e.clientX, y: e.clientY, t: performance.now() }
}

function onWindowPointerUp(e: PointerEvent): void {
  if (!downInfo) return
  const info = downInfo
  downInfo = null
  const dx = e.clientX - info.x
  const dy = e.clientY - info.y
  if (Math.hypot(dx, dy) > 8) return // 拖拽, 忽略
  if (performance.now() - info.t > 600) return // 长按, 忽略
  handleClick(e)
}

function handleClick(e: PointerEvent): void {
  if (!camera || !canvasEl || cards.length === 0) return
  const rect = canvasEl.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(ndc, camera)

  const meshes: THREE.Object3D[] = []
  for (const c of cards) if (c.mesh.visible) meshes.push(c.mesh)
  const hits = raycaster.intersectObjects(meshes, false)
  const hit = hits[0]
  if (!hit) return

  const idx = hit.object.userData.index as number
  if (typeof idx !== 'number') return
  const card = cards[idx]
  if (!card) return

  const item = card.item
  if (item.playlistId === '__empty__') return

  const centerIdx = Math.round(centerTarget)
  if (idx === centerIdx) {
    emit('select', item)
  } else {
    centerTarget = idx
    clampCenter()
  }
}

function onKey(e: KeyboardEvent): void {
  if (!props.show || cards.length === 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    centerTarget++
    clampCenter()
    e.preventDefault()
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    centerTarget--
    clampCenter()
    e.preventDefault()
  } else if (e.key === 'Enter') {
    const i = Math.round(centerTarget)
    const c = cards[i]
    if (c && c.item.playlistId !== '__empty__') emit('select', c.item)
  }
}

function onResize(): void {
  if (!containerRef.value || !renderer || !camera) return
  const w = containerRef.value.clientWidth || window.innerWidth
  const h = containerRef.value.clientHeight || window.innerHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

// ============================================================
//  数据加载 (歌单优先, 回退播放队列)
// ============================================================
async function loadPlaylists(): Promise<void> {
  try {
    const res = await songListAPI.getAll()
    if (res && res.success && Array.isArray(res.data) && res.data.length) {
      playlists.value = res.data as PlaylistMeta[]
    }
  } catch {
    // 静默回退到播放队列
  }
}

function rebuildIfNeeded(): void {
  if (!scene) return
  const items = shelfItems.value
  const sig = items.map((i) => `${i.type}:${i.playlistId}`).join('|')
  if (sig === lastSignature) return
  lastSignature = sig
  buildCards(items)
}

// ============================================================
//  Three.js 初始化
// ============================================================
function initThree(): void {
  if (!containerRef.value || renderer) return
  const w = containerRef.value.clientWidth || window.innerWidth
  const h = containerRef.value.clientHeight || window.innerHeight

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100)
  camera.position.set(0, 0, 6)
  // 让中心卡 (py=layout.sideY) 落在屏幕垂直中心
  camera.lookAt(0, layout.sideY, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  renderer.setClearColor(0x000000, 0)
  maxAnisotropy = renderer.capabilities.getMaxAnisotropy()

  const canvas = renderer.domElement
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.zIndex = '0'
  canvas.style.pointerEvents = props.show ? 'auto' : 'none'
  containerRef.value.appendChild(canvas)
  canvasEl = canvas

  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onWindowPointerUp)
  window.addEventListener('keydown', onKey)

  resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(containerRef.value)
}

// ============================================================
//  生命周期
// ============================================================
watch(
  () => props.show,
  (v) => {
    if (v) startAnimation()
    else stopAnimation()
    if (canvasEl) canvasEl.style.pointerEvents = v ? 'auto' : 'none'
  }
)

watch(shelfItems, rebuildIfNeeded, { deep: true })

onMounted(async () => {
  initThree()
  await loadPlaylists()
  rebuildIfNeeded()
  if (props.show) startAnimation()
})

onBeforeUnmount(() => {
  disposed = true
  stopAnimation()
  if (canvasEl) {
    canvasEl.removeEventListener('wheel', onWheel)
    canvasEl.removeEventListener('pointerdown', onPointerDown)
  }
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('keydown', onKey)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  clearCards()
  if (renderer) {
    renderer.dispose()
    renderer.forceContextLoss?.()
    if (canvasEl && canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl)
    renderer = null
  }
  scene = null
  camera = null
  canvasEl = null
})
</script>

<style scoped>
.shelf-container {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.35s ease;
}
.shelf-container.is-hidden {
  opacity: 0;
  pointer-events: none;
}
.shelf-container :deep(canvas) {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: auto;
  display: block;
}

.shelf-focus-info {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  z-index: 2;
  pointer-events: none;
  text-align: center;
  max-width: 70%;
}
.shelf-focus-title {
  color: #fff;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shelf-focus-sub {
  margin-top: 4px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shelf-hint {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 2;
  pointer-events: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 12px;
  white-space: nowrap;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}

.shelf-fade-enter-active,
.shelf-fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.shelf-fade-enter-from,
.shelf-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
