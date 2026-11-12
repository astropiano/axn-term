import type { Meta, StoryObj } from '@storybook/react-vite';
import { CloseConfirmModal } from './CloseConfirmModal';

const meta: Meta<typeof CloseConfirmModal> = {
  component: CloseConfirmModal,
  args: {
    sessionCount: 3,
    runningCount: 1,
    onCancel: () => {},
    onConfirm: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * One window open — the classic confirm: sessions are saved on close and
 * the countdown defaults to confirming.
 */
export const SingleWindow: Story = {};

/** No running processes — the warning line disappears. */
export const SingleWindowIdle: Story = {
  args: { runningCount: 0 },
};

/**
 * Other windows open — the user picks between discarding this window's
 * sessions and closing all windows with state saved. The countdown and
 * Enter default to "Close all & save".
 */
export const MultiWindow: Story = {
  args: {
    otherWindowCount: 2,
    onCloseThisWindow: () => {},
  },
};

/** Many sessions + one running process in a window among several. */
export const MultiWindowBusy: Story = {
  args: {
    sessionCount: 7,
    runningCount: 4,
    otherWindowCount: 3,
    onCloseThisWindow: () => {},
  },
};
