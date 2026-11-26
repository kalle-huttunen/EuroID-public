import '@testing-library/jest-dom';

// Mock window.matchMedia for Ant Design responsive components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock ResizeObserver for React Flow components
global.ResizeObserver = class ResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ target: document.createElement('div') } as unknown as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
};

// Mock DOMMatrixReadOnly for React Flow
class DOMMatrixReadOnly {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
    this.m22 = scale !== undefined ? +scale : 1;
  }
}
// @ts-expect-error - test environment override
global.DOMMatrixReadOnly = DOMMatrixReadOnly;

// Mock HTMLElement dimensions for React Flow
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});

// Mock SVGElement.getBBox for React Flow
if (typeof SVGElement !== 'undefined') {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 100, height: 100 } as DOMRect);
}

// Mock import.meta.env for tests
Object.defineProperty(import.meta, 'env', {
  value: {
    VITE_AUTH_DISABLED: 'true',
    VITE_API_BASE_URL: '/api/v1',
    VITE_OIDC_AUTHORITY: 'https://test.example.com',
    VITE_OIDC_CLIENT_ID: 'test-client',
    VITE_OIDC_ROLE_CLAIM: 'roles',
    VITE_DEV_TENANT_ID: 'dev-tenant',
    MODE: 'test',
    DEV: true,
  },
  writable: true,
});
