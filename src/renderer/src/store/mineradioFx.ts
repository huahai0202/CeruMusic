import { defineStore } from 'pinia'

/**
 * mineradioFx — 移植自 Mineradio 的视觉参数存档系统
 *
 * 统一管理 3D 粒子舞台 / 3D 歌词舞台 / 玻璃质感 的全部可调参数，
 * 由 ParticleBackground.vue / LyricStage.vue / FxConsole.vue 共享读写，
 * 并通过 pinia-plugin-persistedstate 持久化到 localStorage。
 *
 * 字段命名与 Mineradio 的 fxDefaults 保持一致，便于后续对齐。
 */

export interface MineradioFxState {
  // === 粒子舞台 ===
  preset: number // 0 丝绸 / 1 隧道 / 2 星球 / 3 虚空 / 4 黑胶 / 5 壁纸 / 6 骷髅
  intensity: number // 律动强度 0.2 ~ 1.6
  depth: number // 立体感 0.2 ~ 1.8
  point: number // 点大小缩放
  speed: number // 速度
  twist: number // 扭曲
  color: number // 色彩饱和 0.5 ~ 1.8
  scatter: number // 散射
  bgFade: number // 背景淡出 0 ~ 1
  coverRes: number // 封面清晰度 0.75 ~ 1.55
  bloom: boolean // 辉光层开关
  bloomStrength: number // 辉光强度 0 ~ 1
  edge: boolean // 边缘描边开关
  cinema: boolean // 电影镜头开关
  cinemaShake: number // 镜头晃动 0 ~ 1.8

  // === 视觉染色 ===
  tintColor: string // 视觉主色
  tintStrength: number // 染色强度 0 ~ 1
  tintAuto: boolean // 跟随封面取色

  // === 歌词舞台 ===
  lyricBaseColor: string // 歌词底色
  lyricHiColor: string // 高亮色
  lyricGlowColor: string // 溢光色
  lyricSolarColor: string // 阳光底色
  lyricSparkColor: string // 火花色
  lyricGlow: number // 溢光强度 0 ~ 1.2
  lyricScale: number // 歌词大小 0.5 ~ 1.8
  lyricX: number // 水平位置 -2 ~ 2
  lyricY: number // 垂直位置 -1.2 ~ 1.35

  // === 玻璃质感 ===
  glassAberration: number // 控制台玻璃色差 0 ~ 140
}

export const MINERADIO_FX_DEFAULTS: MineradioFxState = {
  preset: 0,
  intensity: 0.85,
  depth: 1.0,
  point: 1.0,
  speed: 1.0,
  twist: 0,
  color: 1.1,
  scatter: 0,
  bgFade: 0.2,
  coverRes: 1.0,
  bloom: true,
  bloomStrength: 0.62,
  edge: false,
  cinema: true,
  cinemaShake: 1.0,

  tintColor: '#9db8cf',
  tintStrength: 0,
  tintAuto: true,

  lyricBaseColor: '#7fa8e8',
  lyricHiColor: '#ffffff',
  lyricGlowColor: '#4d8eff',
  lyricSolarColor: '#ffc266',
  lyricSparkColor: '#ffe9b8',
  lyricGlow: 0.5,
  lyricScale: 1.0,
  lyricX: 0,
  lyricY: 0,

  glassAberration: 90
}

export const MINERADIO_PRESETS: { id: number; label: string; name: string; desc: string }[] = [
  { id: 0, label: '丝绸', name: 'SILK', desc: '丝绸 — xy 平面涟漪 + 低频呼吸' },
  { id: 1, label: '隧道', name: 'TUNNEL', desc: '隧道 — 圆管自旋 + bass 收缩' },
  { id: 2, label: '星球', name: 'ORBIT', desc: '星球 — 球面膨胀 + treble 闪烁' },
  { id: 3, label: '虚空', name: 'VOID', desc: '虚空 — 隐藏粒子, 让位背景' },
  { id: 4, label: '黑胶', name: 'VINYL', desc: '黑胶 — 唱片封面 + 纹槽' },
  { id: 5, label: '壁纸', name: 'WALLPAPER', desc: '壁纸 — 极光带 + 深度火花' },
  { id: 6, label: '骷髅', name: 'SKULL', desc: '骷髅 — 骨骼光照 + 下颚开合 + 节拍闪光' }
]

export const useMineradioFxStore = defineStore('mineradioFx', {
  state: (): MineradioFxState => ({ ...MINERADIO_FX_DEFAULTS }),
  getters: {
    getPreset: (s) => s.preset,
    getIntensity: (s) => s.intensity,
    getDepth: (s) => s.depth,
    getPoint: (s) => s.point,
    getSpeed: (s) => s.speed,
    getTwist: (s) => s.twist,
    getColor: (s) => s.color,
    getScatter: (s) => s.scatter,
    getBgFade: (s) => s.bgFade,
    getCoverRes: (s) => s.coverRes,
    getBloom: (s) => s.bloom,
    getBloomStrength: (s) => s.bloomStrength,
    getEdge: (s) => s.edge,
    getCinema: (s) => s.cinema,
    getCinemaShake: (s) => s.cinemaShake,
    getTintColor: (s) => s.tintColor,
    getTintStrength: (s) => s.tintStrength,
    getTintAuto: (s) => s.tintAuto
  },
  actions: {
    setPreset(p: number) {
      this.preset = Math.max(0, Math.min(MINERADIO_PRESETS.length - 1, p))
    },
    setField<K extends keyof MineradioFxState>(key: K, value: MineradioFxState[K]) {
      ;(this as unknown as Record<string, unknown>)[key as string] = value
    },
    reset() {
      this.$reset()
    },
    /** 应用一份存档快照（归一化后覆盖全部字段） */
    applySnapshot(raw: Partial<MineradioFxState>) {
      for (const key of Object.keys(MINERADIO_FX_DEFAULTS) as (keyof MineradioFxState)[]) {
        if (raw[key] !== undefined && raw[key] !== null) {
          ;(this as unknown as Record<string, unknown>)[key] = raw[key]
        }
      }
    },
    /** 导出当前存档快照（用于导入/导出） */
    captureSnapshot(): MineradioFxState {
      return { ...this.$state }
    }
  },
  persist: {
    key: 'ceru-mineradio-fx-v1',
    storage: typeof localStorage !== 'undefined' ? localStorage : undefined
  } as any
})
