export type WhilstBand = string | null

declare module 'claude-code' {
  interface PluginState {
    'whilst': { band: WhilstBand }
  }
}
