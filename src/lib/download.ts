/**
 * Скачивание уже полученного blob под именем файла.
 *
 * Именно blob, а не ссылка на /api-роут: все роуты закрыты токеном
 * (x-moonapp-token), который <a download> передать не может — прямая ссылка
 * вернула бы 401. Раньше эта функция лежала отдельной копией в
 * SettingsPage.tsx и LectureRecorderPage.tsx; копии разъехаться не должны,
 * потому что обе описывают один и тот же обход токен-защиты.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Отзываем URL не сразу: Safari/Chrome начинают чтение blob асинхронно.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
