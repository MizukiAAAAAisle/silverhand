// Diagnostic Web asset only. The ordinary product index never loads this file.
(() => {
  const snapshot = {
    version: 1,
    phase: 'before-main',
    nonce: document.currentScript?.dataset.b2StartupDiagnostic ?? null,
    origin: location.origin,
    href: location.href,
    timeOrigin: performance.timeOrigin,
    top: window === window.top,
    readyState: document.readyState,
    mainModuleSeen: !!document.querySelector('script[type="module"]'),
    status: 'unknown',
  };
  try {
    snapshot.appearance = localStorage.getItem('silverhand:appearance');
    snapshot.status = 'observed';
  } catch (error) {
    snapshot.error = String(error);
  }
  Object.defineProperty(window, '__b2AppearanceStartup', {
    value: Object.freeze(snapshot), writable: false, configurable: false,
  });
})();
