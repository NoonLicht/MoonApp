/** Грубая оценка токенов: кириллица ≈ 2–3 символа на токен, берём с запасом. */
const approxTokens = (t: string): number => Math.ceil(t.length / 2.2) + 8;

/** Убирает самые старые сообщения, пока история не влезет в бюджет. system и последнее — остаются. */
export function fitHistory<T extends { role: string; text: string }>(
  msgs: T[],
  budget: number,
): T[] {
  const cost = (m: T): number => approxTokens(m.text);
  let total = msgs.reduce((n, m) => n + cost(m), 0);
  const out = [...msgs];
  for (let i = 0; total > budget && out.length > 1; ) {
    if (i >= out.length - 1) break;
    if (out[i].role === "system") {
      i++;
      continue;
    }
    total -= cost(out[i]);
    out.splice(i, 1);
  }
  return out;
}
