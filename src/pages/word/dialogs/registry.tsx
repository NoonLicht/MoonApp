import type { ComponentType } from "react";
import FormDialog, { type FormSpec } from "@/pages/word/dialogs/form";
import * as F from "@/pages/word/dialogs/specsFormat";
import * as M from "@/pages/word/dialogs/specsMisc";
import {
  BookmarkDialog,
  CrossRefDialog,
  FindDialog,
  LinkDialog,
  SymbolDialog,
  type DlgProps,
} from "@/pages/word/dialogs/custom1";
import {
  AboutDialog,
  ChartDataDialog,
  ChartPickerDialog,
  CommandsDialog,
  EquationGalleryDialog,
  ExistingRecipientsDialog,
  FileCommandDialog,
  IconsDialog,
  MacrosDialog,
  PasteSpecialDialog,
  QuickPartsDialog,
  RecipientsDialog,
  SaveAsDialog,
  SmartArtPickerDialog,
  SourcesDialog,
  TemplatesDialog,
  ThesaurusDialog,
  WordCountDialog,
  ZoomDialog,
} from "@/pages/word/dialogs/custom2";
import type { Cx, Params } from "@/pages/word/ribbon/types";

const FORMS: Record<string, (cx: Cx) => FormSpec> = {
  font: F.font,
  paragraph: F.paragraph,
  pageSetup: F.pageSetup,
  columns: F.columns,
  lineNumbers: F.lineNumbers,
  hyphenation: F.hyphenation,
  paragraphBorders: F.paragraphBorders,
  defineBullet: F.defineBullet,
  defineNumber: F.defineNumber,
  defineMultilevel: F.defineMultilevel,
  setNumberingValue: F.setNumberingValue,
  phonetic: F.phonetic,
  enclose: F.enclose,
  dropCap: F.dropCap,
  pageNumberFormat: F.pageNumberFormat,
  watermark: F.watermark,
  pageBorders: F.pageBorders,
  coverPage: F.coverPage,
  insertTable: M.insertTable,
  newComment: M.newComment,
  field: M.field,
  docProperty: M.docProperty,
  dateTime: M.dateTime,
  signatureLine: M.signatureLine,
  equationText: M.equationText,
  toc: M.toc,
  noteOptions: M.noteOptions,
  caption: M.caption,
  tableOfFigures: M.tableOfFigures,
  markEntry: M.markEntry,
  insertIndex: M.insertIndex,
  markCitation: M.markCitation,
  bibliography: M.bibliography,
  createSource: M.createSource,
  language: M.language,
  trackingOptions: M.trackingOptions,
  restrict: M.restrict,
  cellMargins: M.cellMargins,
  splitCells: M.splitCells,
  sortTable: M.sortTable,
  sortParagraphs: M.sortParagraphs,
  tableToText: M.tableToText,
  tableFormula: M.tableFormula,
  tableProperties: M.tableProperties,
  newTableStyle: M.newTableStyle,
  modifyTableStyle: M.modifyTableStyle,
  crop: M.crop,
  createStyle: M.createStyle,
  envelopes: M.envelopes,
  labels: M.labels,
  finishMerge: M.finishMerge,
  findRecipient: M.findRecipient,
  insertMergeField: M.insertMergeField,
  matchFields: M.matchFields,
  controlProperties: M.controlProperties,
};

/** Диалоги-обёртки: тот же компонент с готовыми параметрами. */
const WITH: Record<string, [ComponentType<DlgProps>, Params]> = {
  compare: [
    FileCommandDialog,
    { title: "Compare", accept: ".docx,.doc,.odt,.rtf,.txt", cmd: "review.compare" },
  ],
  insertObject: [FileCommandDialog, { title: "Object", accept: "*/*", cmd: "insert.object" }],
  textFromFile: [
    FileCommandDialog,
    {
      title: "Text from File",
      accept: ".docx,.doc,.odt,.rtf,.txt,.md,.html",
      cmd: "insert.textFromFile",
    },
  ],
  addFont: [
    FileCommandDialog,
    { title: "Add Font…", accept: ".ttf,.otf,.ttc,.woff,.woff2", cmd: "font.add" },
  ],
  citation: [SourcesDialog, { mode: "cite" }],
  sources: [SourcesDialog, { mode: "manage" }],
  insertChart: [ChartPickerDialog, { mode: "insert" }],
  changeChartType: [ChartPickerDialog, { mode: "change" }],
  newRecipientList: [RecipientsDialog, { name: "newRecipientList" }],
  editRecipients: [RecipientsDialog, { name: "editRecipients" }],
  exportPdf: [SaveAsDialog, { format: "pdf" }],
  autoText: [QuickPartsDialog, { name: "autoText" }],
  replace: [FindDialog, { tab: "replace" }],
  goto: [FindDialog, { tab: "goto" }],
  find: [FindDialog, { tab: "find" }],
};

const CUSTOM: Record<string, ComponentType<DlgProps>> = {
  symbol: SymbolDialog,
  link: LinkDialog,
  bookmark: BookmarkDialog,
  crossReference: CrossRefDialog,
  chartData: ChartDataDialog,
  insertSmartArt: SmartArtPickerDialog,
  icons: IconsDialog,
  equationGallery: EquationGalleryDialog,
  thesaurus: ThesaurusDialog,
  wordCount: WordCountDialog,
  zoom: ZoomDialog,
  commands: CommandsDialog,
  about: AboutDialog,
  macros: MacrosDialog,
  templates: TemplatesDialog,
  quickParts: QuickPartsDialog,
  pasteSpecial: PasteSpecialDialog,
  saveAs: SaveAsDialog,
  existingRecipients: ExistingRecipientsDialog,
};

export interface OpenDialog {
  name: string;
  props: Params;
}

/** Показывает диалог по имени из ленты/меню. Неизвестное имя ничего не рисует. */
export default function DialogHost({
  dialog,
  cx,
  onClose,
}: {
  dialog: OpenDialog | null;
  cx: Cx;
  onClose: () => void;
}) {
  if (!dialog) return null;
  const { name, props } = dialog;
  const form = FORMS[name];
  if (form)
    return <FormDialog key={name} spec={form(cx)} cx={cx} props={props} onClose={onClose} />;
  const wrapped = WITH[name];
  if (wrapped) {
    const [Cmp, extra] = wrapped;
    return <Cmp key={name} cx={cx} props={{ ...extra, ...props }} onClose={onClose} />;
  }
  const Cmp = CUSTOM[name];
  return Cmp ? <Cmp key={name} cx={cx} props={props} onClose={onClose} /> : null;
}
