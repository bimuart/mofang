import { computed, ref, watch } from 'vue';
import type { Locale } from './messages';
import { STORAGE_LOCALE, STORAGE_THEME, messages } from './messages';

export type ColorScheme = 'light' | 'dark';

/** 无本地偏好时，跟随系统/浏览器浅色或深色方案 */
function defaultThemeFromSystem(): ColorScheme {
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function loadStoredTheme(): ColorScheme {
  try {
    const v = localStorage.getItem(STORAGE_THEME);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* ignore */
  }
  return defaultThemeFromSystem();
}

/**
 * 无本地偏好时：按 `navigator.languages` / `navigator.language` 推断。
 * 仅支持 zh、en；其它语言回退为 en。
 */
function defaultLocaleFromNavigator(): Locale {
  if (typeof navigator === 'undefined') return 'en';

  const list =
    typeof navigator.languages !== 'undefined' && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const raw of list) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

function loadStoredLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_LOCALE);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    /* ignore */
  }
  return defaultLocaleFromNavigator();
}

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  let s = template;
  for (const [k, v] of Object.entries(params)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function useAppChrome() {
  const colorScheme = ref<ColorScheme>(loadStoredTheme());
  const locale = ref<Locale>(loadStoredLocale());

  const isDark = computed(() => colorScheme.value === 'dark');

  function t(key: string, params?: Record<string, string | number>): string {
    const table = messages[locale.value] ?? messages.zh;
    const fallback = messages.zh[key] ?? key;
    const raw = table[key] ?? fallback;
    return interpolate(raw, params);
  }

  watch(
    [colorScheme, locale],
    () => {
      try {
        localStorage.setItem(STORAGE_THEME, colorScheme.value);
        localStorage.setItem(STORAGE_LOCALE, locale.value);
      } catch {
        /* ignore */
      }
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = colorScheme.value;
        document.documentElement.lang = locale.value === 'zh' ? 'zh-CN' : 'en';
        document.title = t('app.title');
      }
    },
    { immediate: true },
  );

  function toggleColorScheme() {
    colorScheme.value = colorScheme.value === 'light' ? 'dark' : 'light';
  }

  function setLocale(next: Locale) {
    locale.value = next;
  }

  return {
    colorScheme,
    isDark,
    locale,
    t,
    toggleColorScheme,
    setLocale,
  };
}
