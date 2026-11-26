/**
 * antd 5 renders its static Modal.confirm, message and notification with react-dom's legacy
 * `render`, which React 19 no longer has, so without the app's setup module they render nothing:
 * the confirmation never opens and its action cannot run, and the toast is never seen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal, message } from 'antd';
import '../antd-react19';

const TITLE = 'Run the probe?';
// antd also puts the confirm's title in a hidden modal title; match the visible one.
const confirmTitle = () => screen.queryByText(TITLE, { selector: '.ant-modal-confirm-title' });

describe('antd static methods with the React 19 setup', () => {
  afterEach(async () => {
    Modal.destroyAll();
    message.destroy();
    // Closing them makes React schedule unmounts (and the setup module defers its own by a
    // timeout); a few event-loop turns let those finish before the next test starts.
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it('renders a static Modal.confirm whose OK runs onOk and then removes the dialog', async () => {
    const user = userEvent.setup();
    const onOk = vi.fn();
    Modal.confirm({ title: TITLE, okText: 'Yes, run', onOk });

    await waitFor(() => expect(confirmTitle()).toBeInTheDocument());
    const dialog = confirmTitle()!.closest('.ant-modal') as HTMLElement;
    await user.click(within(dialog).getByRole('button', { name: 'Yes, run' }));

    expect(onOk).toHaveBeenCalledTimes(1);
    // The dialog's root is unmounted after closing, not left hidden in the document.
    await waitFor(() => expect(confirmTitle()).toBeNull());
  });

  it('renders a static message.success toast', async () => {
    message.success('Probe saved');

    expect(await screen.findByText('Probe saved')).toBeInTheDocument();

    // The toast closes itself with a 3 s timer. Remove it here and wait until it is gone, so
    // that timer is cleared: left pending, it fires after this file's environment is torn down
    // and React's follow-up work throws "window is not defined" in whichever run is still alive.
    message.destroy();
    await waitFor(() => expect(screen.queryByText('Probe saved')).toBeNull());
  });
});
