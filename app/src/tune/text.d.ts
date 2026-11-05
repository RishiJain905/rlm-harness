// KV cache: none
// The stage prompts are imported as text (`with { type: "text" }`), so `bun build --compile` carries them.
declare module "*.md" {
  const text: string;
  export default text;
}
