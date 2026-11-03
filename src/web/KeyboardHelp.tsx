import { useRef, type ReactNode } from 'react';
import { useModalFocus } from './useModalFocus';
import { Icon } from './icons';
import { tools } from './modeling';
import { views } from './views';
import { modifierLabel as mod } from './useKeyboardShortcuts';

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <HelpDialog>
        <header className="card-head">
          <span className="tool-glyph">
            <Icon name="help" size={20} />
          </span>
          <div>
            <h2>Shortcuts</h2>
            <p>Single keys work whenever focus is not in a text field.</p>
          </div>
          <button
            type="button"
            className="icon-button quiet"
            aria-label="Close"
            autoFocus
            onClick={() => onClose()}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="help-grid">
          <section>
            <h3>Anywhere</h3>
            <dl>
              <div>
                <dt>
                  <kbd>{mod}K</kbd> <kbd>/</kbd>
                </dt>
                <dd>All commands</dd>
              </div>
              <div>
                <dt>
                  <kbd>{mod}Z</kbd>
                </dt>
                <dd>Undo</dd>
              </div>
              <div>
                <dt>
                  <kbd>{mod}⇧Z</kbd>
                </dt>
                <dd>Redo</dd>
              </div>
              <div>
                <dt>
                  <kbd>{mod}A</kbd>
                </dt>
                <dd>Select all results</dd>
              </div>
              <div>
                <dt>
                  <kbd>Esc</kbd>
                </dt>
                <dd>Exit replay · cancel drag · close tool · clear selection</dd>
              </div>
              <div>
                <dt>
                  <kbd>⏎</kbd>
                </dt>
                <dd>Apply the open form</dd>
              </div>
            </dl>
          </section>
          <section>
            <h3>View</h3>
            <dl>
              {views.map((v, i) => (
                <div key={v.view}>
                  <dt>
                    <kbd>{i + 1}</kbd>
                  </dt>
                  <dd>{v.label}</dd>
                </div>
              ))}
              <div>
                <dt>
                  <kbd>F</kbd>
                </dt>
                <dd>Fit model</dd>
              </div>
              <div>
                <dt>
                  <kbd>S</kbd>
                </dt>
                <dd>Snap 1 mm · 15° · 0.1×</dd>
              </div>
              <div>
                <dt>
                  <kbd>[</kbd> <kbd>]</kbd>
                </dt>
                <dd>Step through the active build replay</dd>
              </div>
              <div>
                <dt>
                  <kbd>Q</kbd>
                </dt>
                <dd>Section view</dd>
              </div>
              <div>
                <dt>
                  <kbd>G</kbd>
                </dt>
                <dd>Measure distance</dd>
              </div>
            </dl>
          </section>
          <section>
            <h3>Operations</h3>
            <dl>
              {tools.map((spec) => (
                <div key={spec.tool}>
                  <dt>
                    <kbd>{spec.shortcut}</kbd>
                  </dt>
                  <dd>{spec.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <p className="field-hint">
          Drag any field label, or an X/Y/Z badge, sideways to adjust its value with a live exact preview.
          Shift is fine, Alt is coarse. Mouse: drag to orbit, right-drag or two-finger drag to pan, scroll to
          zoom toward the cursor. Shift-click builds a multi-selection; right-click a result for its actions.
        </p>
      </HelpDialog>
    </div>
  );
}

function HelpDialog({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  return (
    <div ref={ref} className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      {children}
    </div>
  );
}
