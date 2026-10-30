import { ref, shallowRef } from 'vue';
import { ApiError } from '../api/client';

export function useAsync<T>(loader: () => Promise<T>) {
  const data = shallowRef<T | null>(null);
  const error = ref<string>('');
  const errorCode = ref<string>('');
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    errorCode.value = '';
    try {
      data.value = await loader();
    } catch (cause) {
      if (cause instanceof ApiError) {
        error.value = cause.message;
        errorCode.value = cause.code;
      } else {
        error.value = '页面加载失败，请稍后重试';
        errorCode.value = 'E_UNKNOWN';
      }
    } finally {
      loading.value = false;
    }
  }

  return { data, error, errorCode, loading, load };
}
