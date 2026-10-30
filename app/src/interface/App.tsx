// KV cache: none
// The interactive app. In step 2 it is one dim line; step 7 builds the real screen.

import { Text, render, useApp, useInput } from "ink";
import { APP_VERSION } from "../version.ts";

export function App() {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "q") exit();
  });
  return <Text dimColor>{`rlmh ${APP_VERSION}  press q or Ctrl+C to quit`}</Text>;
}

/** Render the app and wait until it exits (q, or Ctrl+C through Ink's own handler). */
export async function runApp(): Promise<void> {
  const instance = render(<App />);
  await instance.waitUntilExit();
}
