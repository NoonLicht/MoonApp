/**
 * Декодирует chunk'и Server-Sent Events из fetch ReadableStream.
 * Колбэк onJson вызывается на каждый "data:"-фрагмент (после удаления префикса).
 */
async function consumeSSE(body, onJson) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = () => {
    // SSE фрагменты разделены двойным переносом строки.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onJson(JSON.parse(payload));
        } catch {
          /* пропускаем не-JSON фрагменты */
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush();
  }
  buffer += decoder.decode();
  flush();
}

module.exports = { consumeSSE };
