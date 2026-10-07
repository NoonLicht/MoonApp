import { app } from "electron";

// Имя приложения — ДО require("./storagePath"): storagePath спрашивает
// app.getPath("userData"), а без явного setName() Electron берёт "name" из
// package.json ("moonapp", маленькими буквами) вместо "MoonApp". На Windows
// незаметно (ФС регистронезависима), но на Linux (~/.config/...) это была бы
// уже другая, «неправильная» по регистру папка. app.setName() можно звать
// сразу после require("electron"), app.whenReady() для этого не нужен.
// Отдельный модуль нужен ради порядка: main.ts импортирует его ПЕРВЫМ, до
// storagePath и остальных модулей (tsc сохраняет порядок require как в import).
app.setName("MoonApp");
