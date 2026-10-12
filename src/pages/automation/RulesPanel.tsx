import FolderPicker from "@/components/FolderInput";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Trash2, Save, FolderInput } from "lucide-react";
import { Glass, Btn, SectionHead, EmptyHint } from "@/components/ui";
import { useI18n } from "@/app/i18n";
import { api } from "@/api/client";

type Rules = Awaited<ReturnType<typeof api.automationRules>>;
type Rule = Rules["rules"][number];
type Step = Rule["steps"][number];
type StepType = Step["type"];

const STEP_TYPES: StepType[] = ["if", "move", "copy", "rename", "zip"];

/** Поля параметров по типу шага: ключ → ключ i18n подписи. */
const FIELDS: Record<StepType, string[]> = {
  if: ["ext", "nameRegex", "minSizeMb", "maxSizeMb"],
  move: ["dest"],
  copy: ["dest"],
  rename: ["template"],
  zip: ["dest"],
};

const uid = (): string => Math.random().toString(36).slice(2, 10);

function StepNode({ data }: NodeProps) {
  const d = data as { title: string; sub: string; kind: string; selected: boolean };
  return (
    <div
      className="glass"
      style={{
        padding: "8px 12px",
        minWidth: 150,
        borderRadius: 10,
        border: `2px solid ${d.selected ? "var(--accent, #f0a63d)" : "var(--glass-border)"}`,
        background: d.kind === "trigger" ? "rgba(63,199,171,0.15)" : undefined,
      }}
    >
      {d.kind !== "trigger" && <Handle type="target" position={Position.Left} />}
      <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
      <div className="muted-sm" style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}>
        {d.sub}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { step: StepNode };

/**
 * Редактор правил: слева направо — папка-триггер и цепочка шагов (узлы
 * @xyflow/react), под схемой — форма выбранного узла. Цепочка линейная:
 * условие «если» либо пропускает файл дальше, либо останавливает правило.
 */
export default function RulesPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<Rules | null>(null);
  const [draft, setDraft] = useState<Rule | null>(null);
  const [sel, setSel] = useState<string>("trigger");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.automationRules());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const newRule = () => {
    setDraft({
      id: "",
      name: t("automation.rules.newName"),
      enabled: true,
      folder: "",
      steps: [],
      createdAt: Date.now(),
    });
    setSel("trigger");
  };

  const nodes: Node[] = useMemo(() => {
    if (!draft) return [];
    const list: Node[] = [
      {
        id: "trigger",
        type: "step",
        position: { x: 0, y: 30 },
        data: {
          kind: "trigger",
          title: t("automation.rules.trigger"),
          sub: draft.folder || t("automation.rules.noFolder"),
          selected: sel === "trigger",
        },
      },
    ];
    draft.steps.forEach((s, i) =>
      list.push({
        id: s.id,
        type: "step",
        position: { x: (i + 1) * 230, y: 30 },
        data: {
          kind: s.type,
          title: t(`automation.rules.step_${s.type}`),
          sub: Object.values(s.params).filter(Boolean).join(" · ") || "—",
          selected: sel === s.id,
        },
      }),
    );
    return list;
  }, [draft, sel, t]);

  const edges: Edge[] = useMemo(
    () =>
      nodes.slice(1).map((n, i) => ({
        id: `e${i}`,
        source: nodes[i].id,
        target: n.id,
        animated: true,
      })),
    [nodes],
  );

  const update = (patch: Partial<Rule>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const patchStep = (id: string, params: Record<string, string>) =>
    setDraft((d) =>
      d ? { ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, params } : s)) } : d,
    );
  const addStep = (type: StepType) => {
    const step: Step = { id: uid(), type, params: {} };
    setDraft((d) => (d ? { ...d, steps: [...d.steps, step] } : d));
    setSel(step.id);
  };
  const removeStep = (id: string) => {
    setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s.id !== id) } : d));
    setSel("trigger");
  };

  const save = async () => {
    if (!draft) return;
    setError("");
    try {
      const saved = await api.automationRuleSave(draft);
      setDraft(saved);
      await load();
    } catch (e) {
      setError(
        /folder_not_absolute/.test((e as Error).message)
          ? t("automation.rules.folderError")
          : (e as Error).message,
      );
    }
  };

  const selected = draft?.steps.find((s) => s.id === sel);

  return (
    <>
      <SectionHead eyebrow={t("automation.rules.eyebrow")} title={t("automation.rules.title")} />
      <Glass className="p-4">
        <div className="muted-sm">{t("automation.rules.hint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          {data?.rules.map((r) => (
            <Btn
              key={r.id}
              variant={draft?.id === r.id ? "primary" : "ghost"}
              onClick={() => {
                setDraft(r);
                setSel("trigger");
              }}
            >
              {r.enabled ? "● " : "○ "}
              {r.name}
            </Btn>
          ))}
          <Btn icon={Plus} onClick={newRule}>
            {t("automation.rules.new")}
          </Btn>
        </div>

        {!draft && data?.rules.length === 0 && (
          <EmptyHint icon={FolderInput} text={t("automation.rules.empty")} />
        )}

        {draft && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
              <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
                {t("automation.rules.enabled")}
              </label>
              <Btn variant="primary" icon={Save} onClick={save}>
                {t("automation.rules.save")}
              </Btn>
              {draft.id && (
                <Btn
                  icon={Trash2}
                  onClick={async () => {
                    await api.automationRuleDelete(draft.id);
                    setDraft(null);
                    await load();
                  }}
                >
                  {t("ctx.remove")}
                </Btn>
              )}
            </div>
            {error && <div style={{ color: "var(--danger, #e66)", marginTop: 6 }}>{error}</div>}

            <div style={{ height: 150, marginTop: 10 }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                zoomOnScroll={false}
                panOnScroll
                fitView
                proOptions={{ hideAttribution: true }}
                onNodeClick={(_e, n) => setSel(n.id)}
              >
                <Background />
              </ReactFlow>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0" }}>
              {STEP_TYPES.map((s) => (
                <Btn key={s} icon={Plus} onClick={() => addStep(s)}>
                  {t(`automation.rules.step_${s}`)}
                </Btn>
              ))}
            </div>

            {sel === "trigger" && (
              <div>
                <div className="field-label">{t("automation.rules.folder")}</div>
                <FolderPicker
                  placeholder={t("automation.rules.folderPh")}
                  value={draft.folder}
                  onChange={(folder) => update({ folder })}
                />
              </div>
            )}

            {selected && (
              <div>
                <div className="field-label">{t(`automation.rules.step_${selected.type}`)}</div>
                {FIELDS[selected.type].map((f) => (
                  <input
                    key={f}
                    className="input"
                    style={{ width: "100%", marginBottom: 6 }}
                    placeholder={t(`automation.rules.f_${f}`)}
                    value={selected.params[f] ?? ""}
                    onChange={(e) =>
                      patchStep(selected.id, { ...selected.params, [f]: e.target.value })
                    }
                  />
                ))}
                <Btn icon={Trash2} onClick={() => removeStep(selected.id)}>
                  {t("automation.rules.removeStep")}
                </Btn>
              </div>
            )}
          </>
        )}

        {data && data.log.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label">{t("automation.rules.log")}</div>
            {data.log.slice(0, 8).map((l, i) => (
              <div key={i} className="muted-sm">
                {l.ok ? (l.completed ? "✅" : "⏭") : "⛔"} {l.ruleName}: {l.file} — {l.message}
              </div>
            ))}
          </div>
        )}
      </Glass>
    </>
  );
}
