import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'paper.readerFontSize';
const MIN = 16;
const MAX = 23;
const DEFAULT = 18;

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(value) ? Math.min(MAX, Math.max(MIN, Math.round(value))) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function useReaderPrefs() {
  const fontSize = ref(readStored());

  watch(fontSize, (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // 隐私模式下写入会失败，字号仍在本次会话内生效
    }
  });

  return {
    fontSize,
    min: MIN,
    max: MAX,
    canIncrease: computed(() => fontSize.value < MAX),
    canDecrease: computed(() => fontSize.value > MIN),
    increase: () => {
      if (fontSize.value < MAX) fontSize.value += 1;
    },
    decrease: () => {
      if (fontSize.value > MIN) fontSize.value -= 1;
    },
  };
}
