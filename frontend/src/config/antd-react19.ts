/**
 * Lets antd 5's static Modal.confirm, message.* and notification.* render under React 19.
 *
 * antd 5 renders them, and the click wave effect, through react-dom's legacy `render`, which
 * React 19 no longer has, so without this they render nothing. `unstableSetRender` hands antd
 * a createRoot-based render instead, as antd's "v5 for React 19" guide and
 * @ant-design/v5-patch-for-react-19 do. index.tsx imports this module before the app renders.
 *
 * Static calls still render outside the app's ConfigProvider; the colour-mode provider
 * (contexts/color-mode) hands them the app theme with ConfigProvider.config({ holderRender }).
 * Confirmations use App.useApp(); this module keeps the remaining static toasts visible.
 */
import { unstableSetRender } from 'antd';
import { createRoot, type Root } from 'react-dom/client';

// antd renders into the same container again to update or close a dialog: reuse its root.
const roots = new WeakMap<Element | DocumentFragment, Root>();

unstableSetRender((node, container) => {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(node);
  const rendered = root;
  // antd calls the returned unmount from a close callback, while React may still be
  // rendering; unmount a tick later, as antd's own React 18 path defers it too.
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    rendered.unmount();
    if (roots.get(container) === rendered) roots.delete(container);
  };
});
