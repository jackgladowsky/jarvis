// Phase 2 stub. Phase 3 wires this to pi-agent-core + Codex OAuth + the
// four tools. For now, just echo so we can verify the Telegram round-trip.

export async function handleMessage(text: string): Promise<string> {
  return `hello — echo: ${text}`;
}
