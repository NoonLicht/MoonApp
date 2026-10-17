import type { ComponentType } from "react";
import FormDialog from "@/pages/word/dialogs/form";
import type { Params, SheetCx } from "@/pages/sheet/types";
import type { SheetDocs } from "@/pages/sheet/useSheetDocs";
import { FORMS1 } from "@/pages/sheet/dialogs/specs1";
import { FORMS2 } from "@/pages/sheet/dialogs/specs2";
import * as C from "@/pages/sheet/dialogs/Custom";
import { FORMS3 } from "@/pages/sheet/dialogs/specs3";

export interface OpenDialog {
  name: string;
  props: Params;
}

export interface DialogProps {
  cx: SheetCx;
  docs: SheetDocs;
  props: Params;
  onClose: () => void;
}

/** Диалоги со своим устройством (не сводятся к списку полей). */
const COMPONENTS: Record<string, ComponentType<DialogProps>> = {
  nameManager: C.NameManager,
  manageRules: C.ManageRules,
  scenarioManager: C.ScenarioManager,
  scripts: C.Scripts,
  macros: C.Scripts,
  newScript: C.NameScript,
  stopRecording: (p) => <C.NameScript {...p} stop />,
  customViews: C.CustomViews,
  journal: C.Journal,
  commandSearch: C.CommandSearch,
  shortcuts: C.Shortcuts,
  workbookStats: C.Statistics,
  statistics: C.Statistics,
  accessibility: C.Accessibility,
  errorChecking: C.ErrorChecking,
  evaluateFormula: C.EvaluateFormula,
  spelling: C.Spelling,
  thesaurus: C.Thesaurus,
  queries: C.Queries,
  switchWindows: C.Windows,
  unhideWindow: (p) => <C.Windows {...p} hidden />,
  about: C.About,
};

const FORMS = { ...FORMS1, ...FORMS2, ...FORMS3 };

/** Находит диалог по имени: форма из данных либо отдельный компонент. */
export default function DialogHost({
  dialog,
  cx,
  docs,
  onClose,
}: {
  dialog: OpenDialog | null;
  cx: SheetCx;
  docs: SheetDocs;
  onClose: () => void;
}) {
  if (!dialog) return null;
  const Custom = COMPONENTS[dialog.name];
  if (Custom) return <Custom cx={cx} docs={docs} props={dialog.props} onClose={onClose} />;
  const spec = FORMS[dialog.name];
  if (spec) return <FormDialog key={dialog.name} spec={spec} cx={cx} props={dialog.props} onClose={onClose} />;
  // Диалога нет: сообщаем, а не молчим.
  cx.ui.status(`${cx.tw("This dialog is not available yet")}: ${dialog.name}`);
  queueMicrotask(onClose);
  return null;
}
