// Tests import fixture files as text (`?raw`); vitest's bundler resolves it, tsc needs the shape.
declare module '*?raw' {
  const text: string
  export default text
}
