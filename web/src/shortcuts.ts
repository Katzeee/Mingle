import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts of the console, the same on every platform with the platform's modifier:
 * Command on macOS, Ctrl on Windows and Linux. See DESIGN.md, "键盘".
 */
export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

interface Mygo {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
}

function mygo(): Mygo | undefined {
  return (window as { mygo?: Mygo }).mygo;
}

/**
 * In the Mac app the menu bar owns New Agent, Settings, Close Window and Quit (desktop/main.go):
 * the page leaves those keys to it, so that one press does not run twice.
 */
const menuBarOwns = (): boolean => isMac && mygo() !== undefined;

/** Command on macOS, Ctrl elsewhere, without the other one. */
export function withMod(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** How a shortcut reads, for tooltips: "⌘N" on macOS, "Ctrl+N" elsewhere. */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}

/** The same for `aria-keyshortcuts`. */
export function ariaShortcut(key: string): string {
  return `${isMac ? "Meta" : "Control"}+${key}`;
}

export interface ShellShortcuts {
  newAgent: () => void;
  settings: () => void;
  /** The agent at this place in the sidebar, from 0. */
  agent: (index: number) => void;
  /** Escape with nothing else to close it: the sidebar opened over the page on narrow windows. */
  escape: () => void;
}

/** The shell's own shortcuts, listened for on the whole window. */
export function useShellShortcuts(handlers: ShellShortcuts): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const h = current.current;
      if (event.key === "Escape") {
        if (!event.metaKey && !event.ctrlKey && !event.altKey) h.escape();
        return;
      }
      const action = shellAction(event);
      if (action === null) return;
      event.preventDefault();
      if (action === "new") h.newAgent();
      else if (action === "settings") h.settings();
      else if (action === "back") history.back();
      else if (action === "forward") history.forward();
      else if (action === "close") void mygo()?.call("Shell.CloseWindow");
      else if (action === "quit") void mygo()?.call("Shell.Quit");
      else h.agent(action);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

type Action = "new" | "settings" | "back" | "forward" | "close" | "quit" | number;

/** Which shortcut a key press is, if any. */
export function shellAction(event: KeyboardEvent): Action | null {
  const desktop = mygo() !== undefined;
  // A browser has its own Back and Forward; the app's window has none.
  if (desktop && !isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === "ArrowLeft") return "back";
    if (event.key === "ArrowRight") return "forward";
  }
  if (!withMod(event) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return null;
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  if (desktop && isMac && key === "[") return "back";
  if (desktop && isMac && key === "]") return "forward";
  if (menuBarOwns()) return null;
  if (key === "n") return "new";
  if (key === ",") return "settings";
  // Windows and Linux windows have no menu bar to hold these: the page asks the app.
  if (desktop && key === "w") return "close";
  if (desktop && key === "q") return "quit";
  return null;
}

/** Escape backs out of what the element belongs to, as a form being edited or a question asked. */
export function onEscape(run: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    // Handled here: the shell's Escape does not also close the sidebar.
    event.preventDefault();
    run();
  };
}
