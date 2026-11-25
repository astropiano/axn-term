// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { StoryShellProviders } from './storyMocks';
import { Dropdown } from './Dropdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function render(onChange = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <Dropdown
          ariaLabel="Repo"
          value="b"
          onChange={onChange}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
            { value: 'c', label: 'Gamma' },
          ]}
        />
      </StoryShellProviders>,
    ),
  );
  return onChange;
}

const trigger = () => container.querySelector('button[aria-label="Repo"]') as HTMLButtonElement;
const options = () => [...document.body.querySelectorAll('[role="option"]')] as HTMLButtonElement[];

it('shows the selected label and opens a themed option list, not a native select', async () => {
  await render();
  expect(container.querySelector('select')).toBeNull();
  expect(trigger().textContent).toBe('Beta');
  await act(async () => trigger().click());
  expect(options().map((o) => o.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
  expect(options().find((o) => o.getAttribute('aria-selected') === 'true')?.textContent).toBe('Beta');
});

it('picks an option, closes, and calls onChange', async () => {
  const onChange = await render();
  await act(async () => trigger().click());
  await act(async () => options()[2].click());
  expect(onChange).toHaveBeenCalledWith('c');
  expect(options()).toHaveLength(0);
});

it('moves focus with the arrow keys and closes on Escape', async () => {
  await render();
  await act(async () => trigger().click());
  expect(document.activeElement).toBe(options()[1]);
  await act(async () => {
    options()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(document.activeElement).toBe(options()[2]);
  await act(async () => {
    options()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(document.activeElement).toBe(options()[0]);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(options()).toHaveLength(0);
});

it('toggles shut when the trigger is clicked again', async () => {
  await render();
  await act(async () => trigger().click());
  expect(options()).toHaveLength(3);
  await act(async () => trigger().click());
  expect(options()).toHaveLength(0);
});
