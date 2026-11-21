(function () {
  'use strict';

  const STORAGE_KEY = 'desk-theme';
  const VALID_MODES = ['light', 'dark', 'auto'];
  const COLORS = { light: '#f3eee4', dark: '#12110f' };
  const DARK_MEDIA = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  let switchTimer = 0;

  function isValidMode(mode) {
    return VALID_MODES.includes(mode);
  }

  function read() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return isValidMode(value) ? value : null;
    } catch {
      return null;
    }
  }

  function persist(mode) {
    if (!isValidMode(mode)) return;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch { /* 存储不可用时仅跳过持久化 */ }
  }

  function resolve(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return DARK_MEDIA && DARK_MEDIA.matches ? 'dark' : 'light';
  }

  function syncMeta(mode, resolved) {
    const schemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (schemeMeta) {
      schemeMeta.setAttribute('content', mode === 'auto' ? 'light dark' : resolved);
    }
    const themeMeta = document.getElementById('themeColor') || document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', COLORS[resolved]);
    }
  }

  function syncButtons(mode, titles) {
    const buttons = document.querySelectorAll('[data-set-theme]');
    buttons.forEach((button) => {
      const btnMode = button.dataset.setTheme;
      button.setAttribute('aria-pressed', String(btnMode === mode));
      if (titles && titles[btnMode]) {
        button.title = titles[btnMode];
      }
    });
  }

  function apply(mode, options = {}) {
    const nextMode = isValidMode(mode) ? mode : 'auto';
    const resolved = resolve(nextMode);
    const root = document.documentElement;
    root.setAttribute('data-theme-mode', nextMode);
    root.setAttribute('data-theme', resolved);
    syncMeta(nextMode, resolved);
    syncButtons(nextMode, options.titles);
    if (options.remember) persist(nextMode);
    if (typeof options.onChange === 'function') {
      options.onChange({ mode: nextMode, theme: resolved, source: options.source || 'apply' });
    }
    return { mode: nextMode, theme: resolved };
  }

  function originFromEvent(event, mode) {
    if (event && typeof event.clientX === 'number' && (event.clientX !== 0 || event.clientY !== 0)) {
      return { x: event.clientX, y: event.clientY };
    }
    const targetBtn = (event?.currentTarget instanceof HTMLElement ? event.currentTarget : null)
      || document.querySelector(`[data-set-theme="${mode}"]`);
    if (targetBtn) {
      const rect = targetBtn.getBoundingClientRect();
      if (rect.width || rect.height) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function transition(mode, options = {}) {
    const nextMode = isValidMode(mode) ? mode : 'auto';
    const root = document.documentElement;
    const currentMode = root.getAttribute('data-theme-mode') || 'auto';
    const currentTheme = root.getAttribute('data-theme') || resolve(currentMode);
    const targetTheme = resolve(nextMode);

    if (!options.force && currentMode === nextMode && currentTheme === targetTheme) {
      return;
    }

    const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (currentTheme === targetTheme || reducedMotion) {
      apply(nextMode, options);
      return;
    }

    if (typeof document.startViewTransition === 'function') {
      const { x, y } = originFromEvent(options.event, nextMode);
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );
      try {
        const vt = document.startViewTransition(() => {
          apply(nextMode, options);
        });
        vt.ready.then(() => {
          root.animate(
            {
              clipPath: [
                `circle(0px at ${x}px ${y}px)`,
                `circle(${endRadius}px at ${x}px ${y}px)`,
              ],
            },
            {
              duration: 400,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              pseudoElement: '::view-transition-new(root)',
            }
          );
        }).catch(() => {});
        return;
      } catch { /* View Transition 不可用时退回 CSS 过渡 */ }
    }

    root.classList.add('is-theme-switching');
    apply(nextMode, options);
    window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => {
      root.classList.remove('is-theme-switching');
    }, 350);
  }

  function bind(options = {}) {
    const initialMode = isValidMode(options.initialMode)
      ? options.initialMode
      : (document.documentElement.getAttribute('data-theme-mode') || read() || 'auto');

    apply(initialMode, { ...options, remember: false, source: 'init' });

    document.querySelectorAll('[data-set-theme]').forEach((button) => {
      button.addEventListener('click', (event) => {
        transition(button.dataset.setTheme, {
          ...options,
          event,
          remember: true,
          source: 'user',
        });
      });
    });

    if (DARK_MEDIA) {
      const onSchemeChange = () => {
        const currentMode = document.documentElement.getAttribute('data-theme-mode') || 'auto';
        if (currentMode === 'auto') {
          transition('auto', { ...options, remember: false, force: true, source: 'system' });
        }
      };
      if (typeof DARK_MEDIA.addEventListener === 'function') {
        DARK_MEDIA.addEventListener('change', onSchemeChange);
      } else if (typeof DARK_MEDIA.addListener === 'function') {
        DARK_MEDIA.addListener(onSchemeChange);
      }
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      const nextMode = event.newValue === null ? 'auto' : event.newValue;
      if (!isValidMode(nextMode)) return;
      apply(nextMode, { ...options, remember: false, source: 'storage' });
    });

    return {
      getMode: () => document.documentElement.getAttribute('data-theme-mode') || 'auto',
      getTheme: () => document.documentElement.getAttribute('data-theme') || resolve('auto'),
      apply: (mode, opts) => apply(mode, { ...options, ...opts }),
      transition: (mode, opts) => transition(mode, { ...options, ...opts }),
    };
  }

  window.WorkbenchTheme = {
    STORAGE_KEY,
    COLORS,
    DARK_MEDIA,
    read,
    persist,
    resolve,
    apply,
    transition,
    bind,
  };
})();
