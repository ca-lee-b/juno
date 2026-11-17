// Standard USD rates per million tokens, checked 2026-11-02.
// Source: https://developers.openai.com/api/docs/pricing
// Intentionally uses input/output totals only, without cache or service-tier adjustments.
export const MODEL_RATES: Readonly<Record<string, { input: number; output: number }>> = {
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.3-codex": { input: 1.75, output: 14 },
};

export function estimateModelCost(
  model: string | null,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  if (!model) return null;
  const key = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const rates = Object.hasOwn(MODEL_RATES, key) ? MODEL_RATES[key] : undefined;
  if (
    !rates ||
    !Number.isFinite(usage.inputTokens) ||
    !Number.isFinite(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0
  )
    return null;
  return (usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000;
}

export function formatModelCost(cost: number | null): string {
  if (cost === null) return "Rate unavailable";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cost);
}
