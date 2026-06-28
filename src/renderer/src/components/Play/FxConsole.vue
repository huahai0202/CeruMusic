<!--
  FxConsole.vue
  DIY 视觉控制面板 — 移植自 Mineradio 的 bindFxPanel / toggleFx 系统

  功能:
  - 5 个 tab: 预设 / 运动 / 色彩 / 歌词 / 玻璃
  - 滑杆、取色器、开关统一写入 mineradioFx store, 由 ParticleBackground / LyricStage watch 后应用
  - 玻璃质感: SVG feDisplacementMap 色差滤镜 (Mineradio 黄金版不可回退普通毛玻璃)
  - 重置按钮一键还原全部默认值

  挂载: 由 FullPlay.vue 在粒子背景开启时悬浮按钮触发显示
-->
<template>
  <Transition name="fx-fade">
    <div v-if="visible" class="fx-console" @click.stop @wheel.stop>
      <!-- 玻璃色差滤镜 SVG (隐藏) -->
      <svg class="fx-glass-svg" aria-hidden="true" focusable="false">
        <defs>
          <filter id="fxGlassDisplace" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              base-frequency="0.012 0.018"
              num-octaves="2"
              seed="7"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              :scale="glassAberration"
              x-channel-selector="R"
              y-channel-selector="G"
            />
          </filter>
        </defs>
      </svg>

      <div class="fx-header">
        <span class="fx-title">视觉控制台</span>
        <div class="fx-header-actions">
          <button class="fx-icon-btn" title="重置全部" @click="resetAll">
            <RefreshIcon />
          </button>
          <button class="fx-icon-btn" title="关闭" @click="emit('update:visible', false)">
            <CloseIcon />
          </button>
        </div>
      </div>

      <t-tabs v-model="activeTab" class="fx-tabs">
        <!-- ============ 预设 ============ -->
        <t-tab-panel value="preset" label="预设">
          <div class="fx-preset-grid">
            <button
              v-for="p in presets"
              :key="p.id"
              class="fx-preset-card"
              :class="{ active: fx.preset === p.id }"
              :title="p.desc"
              @click="fx.setPreset(p.id)"
            >
              <span class="fx-preset-name">{{ p.name }}</span>
              <span class="fx-preset-label">{{ p.label }}</span>
            </button>
          </div>
          <p class="fx-hint">{{ currentPresetDesc }}</p>
        </t-tab-panel>

        <!-- ============ 运动 ============ -->
        <t-tab-panel value="motion" label="运动">
          <fx-slider v-model="fx.intensity" label="律动强度" :min="0.2" :max="1.6" :step="0.01" />
          <fx-slider v-model="fx.depth" label="立体感" :min="0.2" :max="1.8" :step="0.01" />
          <fx-slider v-model="fx.point" label="点大小" :min="0.3" :max="2.4" :step="0.01" />
          <fx-slider v-model="fx.speed" label="速度" :min="0.1" :max="2.4" :step="0.01" />
          <fx-slider v-model="fx.twist" label="扭曲" :min="-1.2" :max="1.2" :step="0.01" />
          <fx-slider v-model="fx.color" label="色彩饱和" :min="0.5" :max="1.8" :step="0.01" />
          <fx-slider v-model="fx.scatter" label="散射" :min="0" :max="0.5" :step="0.005" />
          <fx-slider v-model="fx.bgFade" label="背景淡出" :min="0" :max="1" :step="0.01" />
          <fx-slider v-model="fx.coverRes" label="封面清晰度" :min="0.75" :max="1.55" :step="0.01" />

          <div class="fx-row">
            <span class="fx-row-label">辉光层</span>
            <t-switch v-model="fx.bloom" />
          </div>
          <fx-slider
            v-if="fx.bloom"
            v-model="fx.bloomStrength"
            label="辉光强度"
            :min="0"
            :max="1"
            :step="0.01"
          />
          <div class="fx-row">
            <span class="fx-row-label">边缘描边</span>
            <t-switch v-model="fx.edge" />
          </div>
          <div class="fx-row">
            <span class="fx-row-label">电影镜头</span>
            <t-switch v-model="fx.cinema" />
          </div>
          <fx-slider
            v-if="fx.cinema"
            v-model="fx.cinemaShake"
            label="镜头晃动"
            :min="0"
            :max="1.8"
            :step="0.01"
          />
        </t-tab-panel>

        <!-- ============ 色彩 ============ -->
        <t-tab-panel value="tint" label="色彩">
          <div class="fx-row">
            <span class="fx-row-label">跟随封面取色</span>
            <t-switch v-model="fx.tintAuto" />
          </div>
          <div v-if="!fx.tintAuto" class="fx-color-row">
            <span class="fx-row-label">视觉主色</span>
            <t-color-picker
              v-model="tintColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <fx-slider
            v-model="fx.tintStrength"
            label="染色强度"
            :min="0"
            :max="1"
            :step="0.01"
          />
          <p class="fx-hint">
            染色强度为 0 时关闭视觉染色; 跟随封面时主色由播放器自动提取自当前封面。
          </p>
        </t-tab-panel>

        <!-- ============ 歌词 ============ -->
        <t-tab-panel value="lyric" label="歌词">
          <div class="fx-color-row">
            <span class="fx-row-label">歌词底色</span>
            <t-color-picker
              v-model="lyricBaseColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <div class="fx-color-row">
            <span class="fx-row-label">高亮色</span>
            <t-color-picker
              v-model="lyricHiColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <div class="fx-color-row">
            <span class="fx-row-label">溢光色</span>
            <t-color-picker
              v-model="lyricGlowColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <div class="fx-color-row">
            <span class="fx-row-label">阳光底色</span>
            <t-color-picker
              v-model="lyricSolarColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <div class="fx-color-row">
            <span class="fx-row-label">火花色</span>
            <t-color-picker
              v-model="lyricSparkColorModel"
              :show-primary-color-preview="false"
              :color-modes="['monochrome']"
              format="HEX"
            />
          </div>
          <fx-slider v-model="fx.lyricGlow" label="溢光强度" :min="0" :max="1.2" :step="0.01" />
          <fx-slider v-model="fx.lyricScale" label="歌词大小" :min="0.5" :max="1.8" :step="0.01" />
          <fx-slider v-model="fx.lyricX" label="水平位置" :min="-2" :max="2" :step="0.01" />
          <fx-slider v-model="fx.lyricY" label="垂直位置" :min="-1.2" :max="1.35" :step="0.01" />
        </t-tab-panel>

        <!-- ============ 玻璃 ============ -->
        <t-tab-panel value="glass" label="玻璃">
          <fx-slider
            v-model="fx.glassAberration"
            label="色差强度"
            :min="0"
            :max="140"
            :step="1"
          />
          <p class="fx-hint">
            控制台自身的玻璃色差质感 (Mineradio 黄金版)。值为 0 时退回普通毛玻璃。
          </p>
          <div class="fx-glass-preview">
            <span>实时预览</span>
          </div>
        </t-tab-panel>
      </t-tabs>
    </div>
  </Transition>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue'
import { CloseIcon, RefreshIcon } from 'tdesign-icons-vue-next'
import { useMineradioFxStore, MINERADIO_PRESETS } from '@renderer/store/mineradioFx'
import FxSlider from './FxSlider.vue'

interface Props {
  visible?: boolean
}
withDefaults(defineProps<Props>(), { visible: false })
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

const fx = useMineradioFxStore()
// 注: Pinia option store 把 state 暴露为响应式实例属性, 故 fx.intensity / fx.preset 等
// 直接 v-model 即写入 store (ParticleBackground / LyricStage watch 后应用)

const presets = MINERADIO_PRESETS
const activeTab = ref<'preset' | 'motion' | 'tint' | 'lyric' | 'glass'>('preset')

const currentPresetDesc = computed(() => presets[fx.preset]?.desc || '')

// 颜色字段双向: t-color-picker v-model 走 computed 显式 setter, 避免直接绑定 store 字段
// 在某些 tdesign 版本下触发 readonly 警告
const tintColorModel = computed({
  get: () => fx.tintColor,
  set: (v: string) => fx.setField('tintColor', v)
})
const lyricBaseColorModel = computed({
  get: () => fx.lyricBaseColor,
  set: (v: string) => fx.setField('lyricBaseColor', v)
})
const lyricHiColorModel = computed({
  get: () => fx.lyricHiColor,
  set: (v: string) => fx.setField('lyricHiColor', v)
})
const lyricGlowColorModel = computed({
  get: () => fx.lyricGlowColor,
  set: (v: string) => fx.setField('lyricGlowColor', v)
})
const lyricSolarColorModel = computed({
  get: () => fx.lyricSolarColor,
  set: (v: string) => fx.setField('lyricSolarColor', v)
})
const lyricSparkColorModel = computed({
  get: () => fx.lyricSparkColor,
  set: (v: string) => fx.setField('lyricSparkColor', v)
})

// 玻璃色差强度 (实时同步到 SVG filter scale)
const glassAberration = computed(() => fx.glassAberration)

function resetAll() {
  fx.reset()
  activeTab.value = 'preset'
}
</script>

<style lang="scss" scoped>
.fx-console {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 420px;
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  background: rgba(18, 18, 24, 0.32);
  // 玻璃色差滤镜 — Mineradio 黄金版质感
  backdrop-filter: blur(22px) saturate(1.35) brightness(1.04);
  -webkit-backdrop-filter: blur(22px) saturate(1.35) brightness(1.04);
  border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.18);
  padding: 18px 20px 14px;
  z-index: 200;
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  user-select: none;
  // 应用 SVG 色差位移 (玻璃质感核心)
  filter: url(#fxGlassDisplace);
}

.fx-glass-svg {
  position: absolute;
  width: 0;
  height: 0;
  pointer-events: none;
}

.fx-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.fx-title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

.fx-header-actions {
  display: flex;
  gap: 4px;
}

.fx-icon-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  &:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }
}

.fx-tabs {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  // tdesign tabs 内边距修正
  :deep(.t-tabs__content) {
    padding-top: 12px;
  }
  :deep(.t-tabs__nav-container) {
    background: transparent;
  }
  :deep(.t-tabs__nav-item) {
    color: rgba(255, 255, 255, 0.65);
    &.t-is-active {
      color: #fff;
    }
  }
  :deep(.t-tabs__bar) {
    background: rgba(255, 255, 255, 0.85);
  }
}

.fx-preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.fx-preset-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 14px 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.78);
  font-family: inherit;
  transition: all 0.22s cubic-bezier(0.25, 0.8, 0.25, 1);

  &:hover {
    background: rgba(255, 255, 255, 0.12);
    transform: translateY(-2px);
    color: #fff;
  }
  &.active {
    background: rgba(255, 255, 255, 0.18);
    border-color: rgba(255, 255, 255, 0.55);
    box-shadow: 0 6px 16px -4px rgba(0, 0, 0, 0.4);
    color: #fff;
  }
}

.fx-preset-name {
  font-size: 10px;
  letter-spacing: 1.2px;
  opacity: 0.7;
}

.fx-preset-label {
  font-size: 14px;
  font-weight: 600;
}

.fx-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 2px;
}

.fx-row-label {
  color: rgba(255, 255, 255, 0.88);
}

.fx-color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 2px;
  :deep(.t-color-picker__trigger) {
    border-radius: 8px;
  }
}

.fx-hint {
  margin: 10px 2px 0;
  font-size: 11px;
  line-height: 1.55;
  color: rgba(255, 255, 255, 0.55);
}

.fx-glass-preview {
  margin-top: 14px;
  height: 64px;
  border-radius: 12px;
  background: linear-gradient(
    135deg,
    rgba(255, 215, 130, 0.55),
    rgba(255, 255, 255, 0.12) 50%,
    rgba(120, 200, 255, 0.45)
  );
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  letter-spacing: 2px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  filter: url(#fxGlassDisplace);
}

.fx-fade-enter-active,
.fx-fade-leave-active {
  transition: all 0.28s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.fx-fade-enter-from,
.fx-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.92);
}
</style>
