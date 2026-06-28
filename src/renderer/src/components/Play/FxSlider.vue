<!--
  FxSlider.vue
  FxConsole 控制面板内的带标签滑杆行
-->
<template>
  <div class="fx-slider">
    <div class="fx-slider-head">
      <span class="fx-slider-label">{{ label }}</span>
      <span class="fx-slider-value">{{ formatValue(modelValue) }}</span>
    </div>
    <t-slider
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      @update:value="onUpdate"
    />
  </div>
</template>

<script lang="ts" setup>
interface Props {
  modelValue: number
  label: string
  min?: number
  max?: number
  step?: number
}
const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 1,
  step: 0.01
})
const emit = defineEmits<{ (e: 'update:modelValue', v: number): void }>()

function onUpdate(v: number | number[]) {
  const n = Array.isArray(v) ? v[0] : v
  if (typeof n === 'number' && !Number.isNaN(n)) {
    emit('update:modelValue', n)
  }
}

function formatValue(v: number): string {
  // 整数步进显示整数, 否则保留 2 位
  if (props.step >= 1) return String(Math.round(v))
  return v.toFixed(2)
}
</script>

<style lang="scss" scoped>
.fx-slider {
  padding: 6px 2px 4px;
}

.fx-slider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.fx-slider-label {
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
}

.fx-slider-value {
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

:deep(.t-slider__track) {
  background: rgba(255, 255, 255, 0.14);
}
:deep(.t-slider__track-inner) {
  background: rgba(255, 255, 255, 0.85);
}
:deep(.t-slider__button) {
  border-color: #fff;
  background: #fff;
}
</style>
