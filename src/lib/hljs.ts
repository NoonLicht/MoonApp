/**
 * Общий экземпляр highlight.js для markdown (заметки) и чата.
 *
 * Полный `highlight.js` регистрирует ~190 языков (~950 КБ в бандле), и
 * highlightAuto перебирает их все. `lib/common` — ~40 самых ходовых языков;
 * дополнительно регистрируем то, что часто встречается на Windows-машине
 * пользователя (PowerShell, .bat, Dockerfile, nginx).
 */
import hljs from "highlight.js/lib/common";
import powershell from "highlight.js/lib/languages/powershell";
import dos from "highlight.js/lib/languages/dos";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";

hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("nginx", nginx);

export default hljs;
