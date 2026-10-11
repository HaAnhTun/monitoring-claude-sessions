// Copy text to the clipboard (04 section 4.3 `CopyButton`, experiment E8): the async clipboard in a secure context
// (http://127.0.0.1 and localhost count as secure), else a hidden text area and `execCommand('copy')`.

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface ClipboardDeps {
  clipboard?: ClipboardLike | undefined;
  isSecureContext: boolean;
  /** Synchronous fallback copy; returns whether it worked. */
  execCopy?: ((text: string) => boolean) | undefined;
}

function isDocument(v: unknown): v is Document {
  return typeof v === 'object' && v !== null && 'createElement' in v && 'body' in v;
}

function isClipboard(v: unknown): v is ClipboardLike {
  return typeof v === 'object' && v !== null && 'writeText' in v && typeof v.writeText === 'function';
}

/** The text area fallback of the legacy page. Fails closed (false) without a DOM. */
function execCommandCopy(text: string): boolean {
  const doc: unknown = Reflect.get(globalThis, 'document');
  if (!isDocument(doc)) return false;
  const parent = doc.body;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  parent.appendChild(ta);
  const previous = doc.activeElement;
  ta.select();
  let ok: boolean;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only copy path on a page that is not a secure context
    ok = doc.execCommand('copy');
  } catch {
    ok = false;
  }
  parent.removeChild(ta);
  if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  return ok;
}

function defaultDeps(): ClipboardDeps {
  const nav: unknown = Reflect.get(globalThis, 'navigator');
  const clipboard: unknown = typeof nav === 'object' && nav !== null && 'clipboard' in nav ? nav.clipboard : undefined;
  const secure: unknown = Reflect.get(globalThis, 'isSecureContext');
  return {
    clipboard: isClipboard(clipboard) ? clipboard : undefined,
    isSecureContext: secure === true,
    execCopy: execCommandCopy,
  };
}

/** Resolves true when the text was copied. Never throws. */
export async function copyText(text: string, deps: ClipboardDeps = defaultDeps()): Promise<boolean> {
  if (deps.clipboard !== undefined && deps.isSecureContext) {
    try {
      await deps.clipboard.writeText(text);
      return true;
    } catch {
      // permission denied or the document is not focused: use the fallback
    }
  }
  try {
    return deps.execCopy?.(text) ?? false;
  } catch {
    return false;
  }
}
