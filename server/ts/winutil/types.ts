/* eslint-disable */
// Автогенерация из ChrisTitusTech/winutil (лицензия MIT, © Chris Titus Tech).
// Типы каталога winutil (данные — winutilTweaks/System/Scripts/Apps).

export interface WuReg {
  key: string;
  name: string;
  type: "REG_DWORD" | "REG_SZ" | "REG_QWORD" | "REG_EXPAND_SZ";
  value: string | number;
  def?: string | number;
}
export interface WuSvc {
  name: string;
  start: string;
  orig: string;
}
export interface WuTweak {
  id: string;
  src: string;
  tab: "wu-essential" | "wu-advanced" | "wu-prefs";
  reg: WuReg[];
  svc: WuSvc[];
  inv?: string;
  undo?: string;
}
export interface WuFeature {
  id: string;
  feature: string[];
  inv?: string;
}
export interface WuDns {
  name: string;
  primary?: string;
  secondary?: string;
  primary6?: string;
  secondary6?: string;
  doh?: string;
  secondaryDoh?: string;
  dohOnly?: boolean;
}
export interface WuAppx {
  id: string;
  pkg: string;
  store?: string;
  cat: string;
}
export interface WuApp {
  id: string;
  name: string;
  cat: string;
  winget?: string;
  desc?: string;
}
export interface WuPanel {
  id: string;
  cmd: string;
}
