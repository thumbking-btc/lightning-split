export interface ClipboardPort {
  readText?(): Promise<string>;
  writeText?(text: string): Promise<void>;
}

function browserClipboard(): ClipboardPort | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}

export async function copyTextToClipboard(
  text: string,
  clipboard: ClipboardPort | undefined = browserClipboard(),
): Promise<boolean> {
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFromClipboard(
  clipboard: ClipboardPort | undefined = browserClipboard(),
): Promise<string | null> {
  if (!clipboard?.readText) return null;
  try {
    const value = await clipboard.readText();
    return value.trim() || null;
  } catch {
    return null;
  }
}
