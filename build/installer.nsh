/*
 * Пользовательские данные MoonApp (папка storage) НЕ ДОЛЖНЫ удаляться при
 * обновлении и переустановке приложения.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ. NSIS-инсталлятор electron-builder при установке
 * новой версии поверх старой сначала тихо запускает деинсталлятор ПРЕДЫДУЩЕЙ
 * версии, а тот удаляет каталог установки целиком (uninstaller.nsh →
 * `RMDir /r $INSTDIR`). До 0.3.4 папка storage (настройки, секреты, скачанные
 * паки апскейла и модели) лежала рядом с exe — то есть ВНУТРИ каталога установки,
 * и каждое обновление/переустановка её стирали. С 0.3.4 приложение держит данные
 * в %APPDATA%\MoonApp\storage (см. electron/storagePath.js), но этого мало:
 * у пользователей, обновляющихся со старой версии, папка ещё лежит рядом с exe, и
 * удалить её успеет старый деинсталлятор. Поэтому данные переносятся в %APPDATA%
 * ДО удаления старой версии:
 *
 *   customInit        — .onInit инсталлятора, вызывается ПОСЛЕ initMultiUser
 *                       (то есть $INSTDIR уже прочитан из реестра старой
 *                       установки) и ДО installSection → uninstallOldVersion.
 *                       Именно здесь спасаются данные версий ≤ 0.3.3.
 *   customRemoveFiles — хук деинсталлятора (в т.ч. тихой деинсталляции перед
 *                       установкой новой версии). Страховка на будущее: сначала
 *                       переносим storage в %APPDATA%, только потом чистим каталог.
 *
 * Копируем ТОЛЬКО отсутствующие файлы: если пользователь уже работает с данными
 * в %APPDATA%, ничего не перетирается (robocopy /XC /XN /XO). Сначала пробуем
 * Rename — перенос внутри тома мгновенный, без копирования гигабайтов моделей.
 */
!include "LogicLib.nsh"

; Куда приложение складывает данные: %APPDATA%\MoonApp\storage.
; Считаем от $PROFILE, а не от $APPDATA: значение $APPDATA зависит от
; SetShellVarContext, а $PROFILE — всегда профиль запустившего инсталлятор.
; !define /ifndef — чтобы проверочные NSIS-скрипты (тесты хука) могли подставить
; свои каталоги и не писать в реальные данные пользователя.
!define /ifndef MOON_APPDATA_DIR "$PROFILE\AppData\Roaming\MoonApp"
!define /ifndef MOON_STORAGE_DIR "${MOON_APPDATA_DIR}\storage"

!macro MoonKeepUserStorage
  ${If} ${FileExists} "$INSTDIR\storage\*.*"
    CreateDirectory "${MOON_APPDATA_DIR}"
    DetailPrint "MoonApp: сохраняю данные пользователя (storage) в %APPDATA%..."

    ; 1) Быстрый путь: перенос каталога целиком (rename в пределах тома).
    ${IfNot} ${FileExists} "${MOON_STORAGE_DIR}\*.*"
      ClearErrors
      Rename "$INSTDIR\storage" "${MOON_STORAGE_DIR}"
      ${If} ${Errors}
        DetailPrint "MoonApp: перенести каталог не удалось (другой том?) — копирую файлы"
      ${EndIf}
    ${EndIf}

    ; 2) Если каталог перенести не получилось или данные в %APPDATA% уже есть —
    ;    копируем ТОЛЬКО отсутствующие файлы: /XC /XN /XO запрещают трогать
    ;    изменённые, «новые» и «старые» файлы, то есть существующее не перетирается.
    ${If} ${FileExists} "$INSTDIR\storage\*.*"
      nsExec::ExecToLog '"$SYSDIR\Robocopy.exe" "$INSTDIR\storage" "${MOON_STORAGE_DIR}" /E /XC /XN /XO /R:1 /W:1 /NFL /NDL /NJH /NJS /NP'
      Pop $0
      DetailPrint "MoonApp: результат копирования storage: $0"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro MoonKeepUserStorage
!macroend

!macro customRemoveFiles
  !insertmacro MoonKeepUserStorage
  RMDir /r $INSTDIR
!macroend
