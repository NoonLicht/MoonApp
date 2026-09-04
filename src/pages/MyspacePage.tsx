import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { FileText, Folder, Plus, Search, Tags, Hash, PanelRightOpen,
  PanelRightClose, PanelLeftOpen, PanelLeftClose, X, Link2, Type,  Bookmark, ChevronRight, ChevronDown, Globe, Trash2, Sparkles,
  Eye, PenLine, Maximize2, Minimize2, Settings2, ZoomIn, ZoomOut } from "lucide-react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { EmptyHint } from "../components/ui";
import { usePageToolbar } from "../components/Toolbar";
import { useI18n } from "../i18n";
import { api } from "../api/client";
import type { VaultFile, VaultSearchResult, VaultTag, VaultBacklink, GraphData, GraphNode, GraphEdge } from "../api/types";
import EditingToolbar from "../components/EditingToolbar";
import GraphView from "../components/GraphView";
import TasksPanel from "../components/TasksPanel";

type Side = "explorer" | "search" | "tags";
type Right = "backlinks" | "outline" | "graph";
interface OFile { path: string; name: string; content: string; frontmatter: Record<string, string>; outline: { level: number; text: string; line: number }[]; backlinks: VaultBacklink[]; modified: boolean; }
function dirname(p: string) { const a = p.replace(/\\/g, "/").split("/"); a.pop(); return a.join("/"); }
const viewTabStyle = (active: boolean): React.CSSProperties => ({display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:8,fontSize:12,fontWeight:active?600:400,background:active?"var(--glass)":"transparent",border:"1px solid var(--glass-border)",color:active?"var(--text-primary)":"var(--text-secondary)",cursor:"pointer",transition:"all 0.15s"});
export default function MyspacePage() {
  const { t } = useI18n();
  // Показываем пустой тулбар, чтобы убрать старую надпись
  usePageToolbar(<div style={{display:"flex",alignItems:"center",gap:10}}></div>, []);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [myspaceView, setMyspaceView] = useState<"notes"|"tasks">("notes");
  const [leftTab, setLeftTab] = useState<Side>("explorer");
  const [rightTab, setRightTab] = useState<Right>("backlinks");
  const [leftW, setLeftW] = useState(260);
  const [rightW, setRightW] = useState(280);
  const [tree, setTree] = useState<VaultFile[]>([]);
  const [exp, setExp] = useState<Set<string>>(new Set());
  const [selPath, setSelPath] = useState<string|null>(null);
  const [openFiles, setOpenFiles] = useState<OFile[]>([]);
  const [activeTab, setActiveTab] = useState<string|null>(null);
  const [sq, setSq] = useState("");
  const [sres, setSres] = useState<VaultSearchResult[]>([]);
  const [tags, setTags] = useState<VaultTag[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [crName, setCrName] = useState("");
  const [crType, setCrType] = useState<"note"|"folder">("note");
  const [edContent, setEdContent] = useState("");
  const saveTimer = useRef<any>(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState<"edit"|"preview"|"split">("split");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Load tree + auto-create welcome note if vault empty
  useEffect(() => {
    loadTree();
    api.myspaceTags().then(setTags).catch(()=>{});
    const timer = setTimeout(() => {
      api.myspaceTree().then(async (t) => {
        setTree(t);
        if (!t || t.length === 0) {
          // Create a "Getting Started" welcome note on first visit
          try {
            await api.myspaceWrite("Welcome.md", 
              "# Welcome to My Space!\n\n" +
              "This is your personal knowledge base. Here's what you can do:\n\n" +
              "## Quick Start\n\n" +
              "- **Create notes** with the + button in the sidebar\n" +
              "- **Link notes** using [[WikiLinks]] like [[Another Note]]\n" +
              "- **Tag content** with #tags for easy organization\n" +
              "- **Search** across all your notes\n\n" +
              "## Features\n\n" +
              "- \Code blocks\ with syntax highlighting\n" +
              "- Task lists: - [ ] todo, - [x] done\n" +
              "- Auto-save while you type\n" +
              "- Backlinks in the right panel\n" +
              "- Full-text search across your vault\n\n" +
              "Start writing by creating a new note or editing this one!\n",
              {title: "Welcome", tags: "getting-started"}
            );
            const upd = await api.myspaceTree();
            setTree(upd);
            // Open the welcome note
            const d = await api.myspaceRead("Welcome.md");
            const f: OFile = {path:d.path, name:d.name, content:d.content,
              frontmatter:d.frontmatter, outline:d.outline, backlinks:d.backlinks, modified:false};
            setOpenFiles([f]);
            setActiveTab("Welcome.md");
            setSelPath("Welcome.md");
            setEdContent(d.content);
          } catch(e:any) { setError("Could not create welcome note: "+e.message); }
        }
      }).catch(()=>{});
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const loadTree = () => { api.myspaceTree().then((t)=>{setTree(t);setExpAutoExpand(t);}).catch(()=>{}); };
  const setExpAutoExpand = (nodes, parentPath="") => {
    const toExpand = new Set();
    const walk = (list, pp) => { for (const n of list) { if (n.type==="folder") { if (n.children && n.children.length > 0) { toExpand.add(n.path); walk(n.children, n.path); } } } };
    walk(nodes, "");
    setExp((prev)=>{const nxt=new Set(prev); toExpand.forEach(p=>nxt.add(p)); return nxt;});
  };
  const openFile = useCallback(async (p: string) => {
    const ex = openFiles.find(f=>f.path===p);
    if (ex) { setActiveTab(p); setSelPath(p); return; }
    try {
      const d = await api.myspaceRead(p);
      if (!d) { setError("File not found: "+p); return; }
      const f: OFile = {path:d.path, name:d.name, content:d.content,
        frontmatter:d.frontmatter, outline:d.outline, backlinks:d.backlinks, modified:false};
      setOpenFiles((prev)=>[...prev, f]);
      setActiveTab(p);
      setSelPath(p);
      setEdContent(d.content);
      setError("");
    } catch(e:any) { setError("Could not open file: "+e.message); }
  }, [openFiles]);

  const closeTab = (p: string) => {
    setOpenFiles((prev)=>prev.filter(f=>f.path!==p));
    if (activeTab===p) {
      const rem = openFiles.filter(f=>f.path!==p);
      setActiveTab(rem.length ? rem[rem.length-1].path : null);
    }
  };



  const schedSave = useCallback((p: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      const f = openFiles.find(x=>x.path===p);
      if (f&&f.modified) {
        try { await api.myspaceWrite(p, f.content, f.frontmatter); setError(""); }
        catch(e:any) { setError("Save failed: "+e.message); }
        setOpenFiles((prev)=>prev.map(x=>x.path===p?{...x,modified:false}:x));
      }
      setSaving(false);
    }, 800);
  }, [openFiles]);

  const updContent = (p: string, c: string) => {
    setOpenFiles((prev)=>prev.map(f=>f.path===p?{...f,content:c,modified:true}:f));
    if (activeTab===p) setEdContent(c);
    schedSave(p);
  };
  useEffect(() => {
    if (activeTab) { const f = openFiles.find(x=>x.path===activeTab); if (f) setEdContent(f.content); }
  }, [activeTab, openFiles]);

  const createItem = async () => {
    if (!crName.trim()) return;
    const base = ""; // root for now
    const p = crType==="note" ? crName.trim()+".md" : crName.trim();
    // Check duplicate
    const dup = (nodes) => { for (const n of nodes) { if (n.path===p) return true; if (n.children && dup(n.children)) return true; } return false; };
    if (dup(tree)) { setError("A file/folder named \""+crName.trim()+"\" already exists"); return; }
    try {
      if (crType==="note") {
        await api.myspaceWrite(p, "", {title: crName.trim()});
        await openFile(p);
      } else {
        await api.myspaceCreateFolder(p);
        toggleExpand(dirname(p));
      }
      loadTree();
      setShowCreate(false);
      setCrName("");
      setError("");
    } catch(e:any) { setError("Failed to create: "+e.message); }
  };

  const delFile = async (p: string) => {
    try { await api.myspaceDelete(p); closeTab(p); loadTree(); setError(""); }
    catch(e:any) { setError("Delete failed: "+e.message); }
  };
  const deleteFolder = async (node: any) => {
    // Move all children notes to root first
    const moveFiles = async (nodes, parentPath) => {
      for (const n of nodes) {
        if (n.type==="note") {
          const destName = n.name;
          const exists = tree.some((x)=>x.path===destName);
          if (exists) {
            setError("Cannot move \""+n.name+"\" ? a file with this name already exists at root");
            continue;
          }
          try { await api.myspaceRename(n.path, destName); } catch(ex) { setError("Failed to move: "+ex.message); }
        } else if (n.type==="folder" && n.children) {
          await moveFiles(n.children, n.path);
        }
      }
    };
    if (node.children) {
      await moveFiles(node.children, node.path);
      await new Promise(r => setTimeout(r, 200)); // wait for moves
    }
    // Delete the now-empty folder
    try { await api.myspaceDelete(node.path); } catch(ex) { setError("Delete failed: "+ex.message); }
    loadTree();
  };

  useEffect(() => {
    if (!sq.trim()) { setSres([]); return; }
    const t = setTimeout(() => { api.myspaceSearch(sq).then(setSres).catch(()=>{}); }, 400);
    return ()=>clearTimeout(t);
  }, [sq]);

  const toggleExpand = (p: string) => {
    setExp((prev)=>{const n=new Set(prev); if(n.has(p))n.delete(p); else n.add(p); return n;});
  };

  const activeFile = openFiles.find(f=>f.path===activeTab);
  const startRes = (s: string, e: React.MouseEvent) => {
    const r = {s, sx: e.clientX, sw: s==="l"?leftW:rightW};
    const mv = (ev: MouseEvent)=>{const d=ev.clientX-r.sx;if(r.s==="l")setLeftW(Math.max(180,Math.min(400,r.sw+d)));else setRightW(Math.max(200,Math.min(500,r.sw-d)));};
    const up = ()=>{document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);};
    document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);
  };

  const [hoverDel, setHoverDel] = useState(null);
  const [dragOverPath, setDragOverPath] = useState(null);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const [graphShowOrphans, setGraphShowOrphans] = useState(true);
  const [graphDepth, setGraphDepth] = useState(3);
  const [graphSearch, setGraphSearch] = useState("");
  // Build graph data from all files' [[wikiLinks]]
  const buildGraphData = useCallback((): GraphData => {
    const nodesMap = new Map<string, GraphNode>();
    const edgeSet = new Set<string>();
    // Build a lookup: lowercase title -> real path (from tree)
    const titleToPath = new Map<string, string>();
    const walkTree = (nodes: VaultFile[]) => {
      for (const n of nodes) {
        if (n.type === "note") {
          const key = n.name.replace(/\.md$/i, "").toLowerCase();
          if (!titleToPath.has(key)) titleToPath.set(key, n.path);
        }
        if (n.children) walkTree(n.children);
      }
    };
    walkTree(tree);
    // Also index openFiles
    for (const f of openFiles) {
      const key = f.name.replace(/\.md$/i, "").toLowerCase();
      if (!titleToPath.has(key)) titleToPath.set(key, f.path);
    }
    // Add openFiles as nodes
    for (const f of openFiles) {
      if (!nodesMap.has(f.path)) {
        nodesMap.set(f.path, { id: f.path, type: "note", label: f.name.replace(/\.md$/, "") });
      }
      // Extract [[WikiLinks]] from content and resolve to real paths
      const linkRegex = /\[\[([^\]]+)\]\]/g;
      let m;
      while ((m = linkRegex.exec(f.content)) !== null) {
        const targetTitle = m[1].trim();
        const targetLower = targetTitle.toLowerCase();
        // Try to find the actual file path from tree or openFiles
        let targetPath = titleToPath.get(targetLower);
        if (!targetPath) {
          // Also try with .md suffix
          targetPath = titleToPath.get(targetLower + ".md") ||
            titleToPath.get(targetLower.replace(/\.md$/i, ""));
        }
        if (!targetPath) {
          // Fallback: sanitize
          targetPath = targetTitle.replace(/[<>:"/\\|?*]/g, "_").trim() + ".md";
        }
        if (!nodesMap.has(targetPath)) {
          nodesMap.set(targetPath, {
            id: targetPath, type: "note",
            label: targetPath.replace(/\.md$/i, "").replace(/_/g, " ")
          });
        }
        const edgeKey = f.path + "||" + targetPath;
        edgeSet.add(edgeKey);
      }
    }
    // Add remaining tree nodes that aren't already in the map
    const addTreeNodes = (nodes: VaultFile[]) => {
      for (const n of nodes) {
        if (n.type === "note" && !nodesMap.has(n.path)) {
          nodesMap.set(n.path, { id: n.path, type: "note", label: n.name.replace(/\.md$/, "") });
        }
        if (n.children) addTreeNodes(n.children);
      }
    };
    addTreeNodes(tree);
    let allNodes = Array.from(nodesMap.values());
    const edges = Array.from(edgeSet).map(k => {
      const [s, t] = k.split("||");
      return { source: s, target: t } as GraphEdge;
    });
    if (activeTab && graphDepth < 5) {
      const visited = new Set<string>();
      const queue: { path: string; depth: number }[] = [{ path: activeTab, depth: 0 }];
      visited.add(activeTab);
      const depthNodes = new Set<string>();
      while (queue.length > 0) {
        const q = queue.shift()!;
        depthNodes.add(q.path);
        if (q.depth >= graphDepth) continue;
        for (const e of edges) {
          const neighbor = e.source === q.path ? e.target : (e.target === q.path ? e.source : null);
          if (neighbor && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ path: neighbor, depth: q.depth + 1 });
          }
        }
      }
      allNodes = allNodes.filter(n => depthNodes.has(n.id));
    }
    if (!graphShowOrphans) {
      const connected = new Set<string>();
      for (const e of edges) { connected.add(e.source); connected.add(e.target); }
      allNodes = allNodes.filter(n => connected.has(n.id));
    }
    if (graphSearch.trim()) {
      const q = graphSearch.toLowerCase();
      allNodes = allNodes.filter(n => n.label.toLowerCase().includes(q));
    }
    const finalIds = new Set(allNodes.map(n => n.id));
    const finalEdges = edges.filter(e => finalIds.has(e.source) && finalIds.has(e.target));
    return { nodes: allNodes, edges: finalEdges };
  }, [openFiles, tree, activeTab, graphDepth, graphShowOrphans, graphSearch]);

  const graphData = useMemo(buildGraphData, [openFiles, tree, activeTab, graphDepth, graphShowOrphans, graphSearch]);
  const [rightSplit, setRightSplit] = useState(55); // % for backlinks top section
  const splitRef = useRef({ dragging: false, startY: 0, startPct: 55 });
  const renderNode = (node: VaultFile, depth: number = 0) => {
    const isExp = exp.has(node.path); const isSel = selPath===node.path;
    if (node.type==="folder") {
      return <div key={node.path}>
        <div onClick={()=>toggleExpand(node.path)}
          onDragOver={(e)=>{e.preventDefault();e.stopPropagation();setDragOverPath(node.path);}}
          onDragLeave={()=>setDragOverPath(null)}
          onDrop={async (e)=>{e.preventDefault();e.stopPropagation();const src=e.dataTransfer.getData("text/plain");if(!src||src===node.path)return;const base=src.split("/").pop()||src;const dest=node.path+"/"+base;const exists=tree.some((n)=>n.path===dest||(n.children&&n.children.some((ch)=>ch.path===dest)));if(exists){setError("A file/folder named \""+base+"\" already exists in this folder");setDragOverPath(null);return;}try{await api.myspaceRename(src,dest);loadTree();setOpenFiles((prev)=>prev.map((f)=>f.path===src?{...f,path:dest,name:base}:f));setActiveTab((prev)=>prev===src?dest:prev);setSelPath((prev)=>prev===src?dest:prev);setError("");}catch(ex){setError("Move failed: "+ex.message);}setDragOverPath(null);}}
          onMouseEnter={()=>setHoverDel(node.path)}
          onMouseLeave={()=>setHoverDel(null)}
          style={{display:"flex",alignItems:"center",gap:4,padding:"3px 6px",paddingLeft:12+depth*16,borderRadius:4,fontSize:12,cursor:"pointer",color:"var(--text-secondary)",background:dragOverPath===node.path?"var(--teal-soft)":"transparent"}}>
          <span>{isExp ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}</span>
          <Folder size={14} style={{color:"var(--amber)"}} />
          <span style={{flex:1}}>{node.name}</span>
          {hoverDel===node.path&&<button onClick={async (e)=>{e.stopPropagation();if(!window.confirm("Delete folder \""+node.name+"\"? Files inside will be moved to root."))return;setError("");await deleteFolder(node);}}
            style={{background:"transparent",border:"none",padding:1,cursor:"pointer",color:"var(--coral)",display:"flex",flexShrink:0}}><Trash2 size={11}/></button>}
        </div>
        {isExp && node.children?.map(child=>renderNode(child, depth+1))}
      </div>;
    }
    return <div key={node.path} onClick={()=>{openFile(node.path);setSelPath(node.path);}}
      draggable={true}
      onDragStart={(e)=>{e.dataTransfer.setData("text/plain",node.path);e.dataTransfer.effectAllowed="move";}}
      onMouseEnter={()=>setHoverDel(node.path)}
      onMouseLeave={()=>setHoverDel(null)}
      style={{display:"flex",alignItems:"center",gap:2,padding:"3px 6px",paddingLeft:28+depth*16,borderRadius:4,fontSize:12,cursor:"pointer",background:isSel?"var(--amber-soft)":"transparent",color:isSel?"var(--amber)":"var(--text-secondary)"}}>
      <FileText size={13} /><span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis"}}>{node.name}</span>
      {hoverDel===node.path&&<button onClick={(e)=>{e.stopPropagation();if(window.confirm("Delete "+node.name+"?")){delFile(node.path);}}}
        style={{background:"transparent",border:"none",padding:1,cursor:"pointer",color:"var(--coral)",display:"flex",flexShrink:0,marginLeft:4}}><Trash2 size={11}/></button>}
    </div>;

  };

  const txStyle: React.CSSProperties = {
    flex:1, minHeight:0, width:"100%", padding:"20px 24px",
    fontFamily:"var(--font-mono)", fontSize:14, lineHeight:1.6,
    border:"none", outline:"none", resize:"none",
    background:"transparent", color:"var(--text-primary)"
  };
  return (<div style={{display:"flex",flexDirection:"column",flex:1,minHeight:0,overflow:"hidden"}}>
      {/* ─── VIEW SWITCHER ─── */}
      <div style={{display:"flex", gap:4, padding:"4px 4px 0 4px"}}>
        <button onClick={()=>setMyspaceView("notes")} style={viewTabStyle(myspaceView==="notes")}>📝 Notes</button>
        <button onClick={()=>setMyspaceView("tasks")} style={viewTabStyle(myspaceView==="tasks")}>✓ Tasks</button>
      </div>
      {myspaceView === "notes" && (<div style={{display:"flex",flex:1,minHeight:0,overflow:"hidden"}}>
      {/* LEFT SIDEBAR */}
      {leftOpen && <div style={{width:leftW,minWidth:180,display:"flex",flexDirection:"column",
        background:"var(--surface-glass)",border:"1px solid var(--glass-border)",borderRadius:12,
        margin:"4px 0 4px 4px",backdropFilter:"blur(8px)",position:"relative",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderBottom:"1px solid var(--glass-border)"}}>
          <div style={{display:"flex",gap:2}}>
            {([["explorer",FileText],["search",Search],["tags",Tags]] as const).map(([id,Icon])=>(
              <button key={id} onClick={()=>setLeftTab(id)}
                style={{background:leftTab===id?"var(--track)":"transparent",border:"none",
                  padding:"4px 7px",borderRadius:6,cursor:"pointer",
                  color:leftTab===id?"var(--text-primary)":"var(--text-tertiary)"}}>
                <Icon size={13}/>
              </button>
            ))}
          </div>
          <button onClick={()=>setLeftOpen(false)}
            style={{background:"transparent",border:"none",padding:3,cursor:"pointer",color:"var(--text-tertiary)"}}>
            <PanelLeftClose size={13}/>
          </button>
        </div>
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {leftTab==="explorer" && <>
            <div style={{display:"flex",gap:4,padding:"4px 8px"}}>
              <button onClick={()=>{setShowCreate(true);setCrType("note");setCrName("");setTimeout(()=>inputRef.current?.focus(),50);}}
                style={{background:"transparent",border:"none",padding:"2px 5px",borderRadius:4,cursor:"pointer",color:"var(--text-tertiary)"}} title="New note"><Plus size={14}/></button>
              <button onClick={()=>{setShowCreate(true);setCrType("folder");setCrName("");setTimeout(()=>inputRef.current?.focus(),50);}}
                style={{background:"transparent",border:"none",padding:"2px 5px",borderRadius:4,cursor:"pointer",color:"var(--text-tertiary)"}} title="New folder"><Folder size={13}/></button>
            </div>
            {showCreate && <div style={{display:"flex",gap:4,padding:"0 8px 6px",alignItems:"center"}}>
              <input ref={inputRef} placeholder={crType==="note"?"Note name...":"Folder name..."}
                value={crName} onChange={e=>setCrName(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")createItem();if(e.key==="Escape"){setShowCreate(false);setCrName("");}}}
                style={{flex:1,padding:"3px 7px",borderRadius:6,border:"1px solid var(--glass-border)",
                  background:"var(--track)",outline:"none",color:"var(--text-primary)",fontSize:12}} />
              <button onClick={()=>{setShowCreate(false);setCrName("");}}
                style={{background:"transparent",border:"none",padding:2,cursor:"pointer",color:"var(--text-tertiary)"}}><X size={12}/></button>
            </div>}
            <div style={{flex:1,overflow:"auto",padding:"2px 4px",minHeight:50}}
              onDragOver={(e)=>{e.preventDefault();e.dataTransfer.dropEffect="move";}}
              onDrop={async (e)=>{e.preventDefault();const src=e.dataTransfer.getData("text/plain");if(!src||!src.includes("/"))return;const base=src.split("/").pop()||src;const exists=tree.some((n)=>n.path===base);if(exists){setError("A file named \""+base+"\" already exists at root");return;}try{await api.myspaceRename(src,base);loadTree();setOpenFiles((prev)=>prev.map((f)=>f.path===src?{...f,path:base,name:base}:f));setActiveTab((prev)=>prev===src?base:prev);setSelPath((prev)=>prev===src?base:prev);setError("");}catch(ex){setError("Move failed: "+ex.message);}}}
            >
              {tree.length===0 && <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>Loading...</div>}
              {tree.map(n=>renderNode(n))}
            </div>
          </>}
          {leftTab==="search" && <>
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",color:"var(--text-tertiary)"}}>
              <Search size={13}/>
              <input placeholder="Search notes..." value={sq} onChange={e=>setSq(e.target.value)} autoFocus
                style={{flex:1,padding:"3px 7px",borderRadius:6,border:"1px solid var(--glass-border)",background:"var(--track)",outline:"none",color:"var(--text-primary)",fontSize:12}} />
            </div>
            <div style={{flex:1,overflow:"auto",padding:"2px 4px"}}>
              {sres.map(r=>(
                <div key={r.path} onClick={()=>{openFile(r.path);setLeftTab("explorer");}}
                  style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,borderBottom:"1px solid var(--glass-border)"}}>
                  <span style={{fontWeight:600,color:"var(--text-primary)"}}>{r.name}</span>
                  <span style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.snippet}</span>
                </div>
              ))}
              {sq.trim() && sres.length===0 && <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>No results</div>}
            </div>
          </>}
          {leftTab==="tags" && <div style={{flex:1,overflow:"auto",padding:"2px 4px"}}>
            {tags.map(t=>(
              <div key={t.tag} onClick={()=>{setLeftTab("search");setSq(t.tag);}}
                style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12}}>
                <Hash size={12} style={{color:"var(--amber)"}} />
                <span style={{flex:1,color:"var(--text-secondary)"}}>{t.tag}</span>
                <span style={{fontSize:11,color:"var(--text-tertiary)",fontFamily:"var(--font-mono)"}}>{t.count}</span>
              </div>
            ))}
            {tags.length===0 && <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>No tags yet</div>}
          </div>}
        </div>
        <div onMouseDown={(e)=>startRes("l",e)} style={{position:"absolute",right:0,top:0,bottom:0,width:4,cursor:"col-resize"}} />
      </div>}
      {/* CENTER EDITOR */}
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        {!leftOpen && <button onClick={()=>setLeftOpen(true)}
          style={{position:"absolute",left:4,top:60,zIndex:10,background:"var(--surface-glass)",
            border:"1px solid var(--glass-border)",borderRadius:6,padding:4,cursor:"pointer",color:"var(--text-tertiary)"}}>
          <PanelLeftOpen size={13}/>
        </button>}
        <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,margin:"4px 0",
          background:"var(--surface-glass)",border:"1px solid var(--glass-border)",borderRadius:12,
          backdropFilter:"blur(8px)",overflow:"hidden"}}>
        {/* Header - matches side panel headers for alignment */}
        <div style={{display:"flex",alignItems:"center",padding:"6px 8px",borderBottom:"1px solid var(--glass-border)",minHeight:28}}>
          <div style={{flex:1,display:"flex",overflow:"auto",gap:2,alignItems:"center"}}>
            {openFiles.map(f=>(
              <div key={f.path} onClick={()=>setActiveTab(f.path)}
                style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:"6px 6px 0 0",fontSize:12,cursor:"pointer",whiteSpace:"nowrap",
                  background:activeTab===f.path?"var(--surface-glass)":"transparent",color:activeTab===f.path?"var(--text-primary)":"var(--text-secondary)",
                  border:activeTab===f.path?"1px solid var(--glass-border)":"1px solid transparent",borderBottom:"none"}}>
                <FileText size={11}/>
                <span>{f.name.replace(/\.md$/,"")}</span>
                {f.modified && <span style={{width:5,height:5,borderRadius:"50%",background:"var(--amber)",display:"inline-block"}}/>}
                <button onClick={(e)=>{e.stopPropagation();closeTab(f.path);}}
                  style={{background:"transparent",border:"none",padding:1,cursor:"pointer",color:"var(--text-tertiary)",display:"flex",marginLeft:2}}><X size={9}/></button>
              </div>
            ))}
            {openFiles.length===0 && <span style={{fontSize:12,color:"var(--text-tertiary)"}}>No open files</span>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            {saving && <span style={{fontSize:11,color:"var(--text-tertiary)"}}>saving...</span>}
            {activeFile && <>
              <button onClick={()=>setPreviewMode("edit")} title="Edit"
                style={{background:previewMode==="edit"?"var(--track)":"transparent",border:"none",padding:"3px 5px",borderRadius:4,cursor:"pointer",color:previewMode==="edit"?"var(--amber)":"var(--text-tertiary)"}}><PenLine size={12}/></button>
              <button onClick={()=>setPreviewMode("split")} title="Split view"
                style={{background:previewMode==="split"?"var(--track)":"transparent",border:"none",padding:"3px 5px",borderRadius:4,cursor:"pointer",color:previewMode==="split"?"var(--amber)":"var(--text-tertiary)"}}><PanelRightOpen size={12}/></button>
              <button onClick={()=>setPreviewMode("preview")} title="Preview"
                style={{background:previewMode==="preview"?"var(--track)":"transparent",border:"none",padding:"3px 5px",borderRadius:4,cursor:"pointer",color:previewMode==="preview"?"var(--amber)":"var(--text-tertiary)"}}><Eye size={12}/></button>
            </>}
            <button onClick={()=>setRightOpen(!rightOpen)}
              style={{background:"transparent",border:"none",padding:3,cursor:"pointer",color:"var(--text-tertiary)"}}>
              {rightOpen ? <PanelRightClose size={13}/> : <PanelRightOpen size={13}/>}
            </button>
          </div>
        </div>
        {/* Editor with live preview & scroll sync */}
        <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
          {error && <div style={{padding:"4px 12px",fontSize:12,color:"var(--coral)",background:"var(--coral-soft)",borderBottom:"1px solid var(--glass-border)"}}>{error}</div>}
          {activeTab && <EditingToolbar
            onFormat={(type, value, selRange) => {
              const ta = document.querySelector(".ms-edit-textarea") as HTMLTextAreaElement;
              if (!ta) return;
              const savedScroll = ta.scrollTop;
              const fullText = ta.value;
              const start = selRange ? selRange.start : ta.selectionStart;
              const end = selRange ? selRange.end : ta.selectionEnd;
              const sel = fullText.substring(start, end);
              const restore = (cb) => {
                ta.focus();
                cb();
                requestAnimationFrame(() => { ta.scrollTop = savedScroll; });
              };
              const wrap = (before, after) => {
                if (sel.startsWith(before) && sel.endsWith(after)) {
                  const inner = sel.substring(before.length, sel.length - after.length);
                  const nc = fullText.substring(0, start) + inner + fullText.substring(end);
                  updContent(activeTab, nc);
                  restore(() => ta.setSelectionRange(start, start + inner.length));
                } else {
                  const nc = fullText.substring(0, start) + before + sel + after + fullText.substring(end);
                  updContent(activeTab, nc);
                  restore(() => ta.setSelectionRange(start + before.length, end + before.length));
                }
              };
              const lineStart = fullText.lastIndexOf("\n", start - 1) + 1;
              const lineEnd = fullText.indexOf("\n", end);
              const curLine = fullText.substring(lineStart, lineEnd === -1 ? fullText.length : lineEnd);
              const insertAtCursor = (txt) => {
                const nc = fullText.substring(0, end) + txt + fullText.substring(end);
                updContent(activeTab, nc);
                restore(() => ta.setSelectionRange(end + txt.length, end + txt.length));
              };
              const toggleHeading = (level) => {
                const prefix = "#".repeat(level) + " ";
                const hMatch = curLine.match(/^(#{1,6}) /);
                let newLine;
                if (hMatch) {
                  const curLevel = hMatch[1].length;
                  if (curLevel === level) newLine = curLine.substring(level + 1);
                  else newLine = prefix + curLine.replace(/^#{1,6} /, "");
                } else {
                  newLine = prefix + curLine;
                }
                const nc = fullText.substring(0, lineStart) + newLine + fullText.substring(lineStart + curLine.length);
                updContent(activeTab, nc);
                const newEnd = lineStart + newLine.length;
                restore(() => ta.setSelectionRange(newEnd, newEnd));
              };
              if (type==="bold") wrap("**","**");
              else if (type==="italic") wrap("*","*");
              else if (type==="strike") wrap("~~","~~");
              else if (type==="underline") wrap("<u>","</u>");
              else if (type==="inlineCode") wrap("`","`");
              else if (type==="superscript") wrap("^","^");
              else if (type==="subscript") wrap("~","~");
              else if (type==="wikiLink") wrap("[[","]]");
              else if (type==="highlight") wrap("==","=="); else if (type==="bgColor") wrap('<span style="background:'+(value||"rgba(240,166,61,0.25)")+'">',"</span>");
              else if (type==="math") wrap("$","$");
              else if (type==="h1") toggleHeading(1);
              else if (type==="h2") toggleHeading(2);
              else if (type==="h3") toggleHeading(3);
              else if (type==="h4") toggleHeading(4);
              else if (type==="h5") toggleHeading(5);
              else if (type==="h6") toggleHeading(6);
              else if (type==="task") insertAtCursor("- [ ] ");
              else if (type==="table") insertAtCursor("|  |  |\n|---|---|\n|  |  |\n\n");
              else if (type==="blockquote") insertAtCursor("> ");
              else if (type==="callout") insertAtCursor("> [!NOTE]\n> ");
              else if (type==="hr") insertAtCursor("\n\n---\n\n");
              else if (type==="codeBlock") insertAtCursor("```\n\n```\n\n");
              else if (type==="mathBlock") insertAtCursor("$\n\n$\n\n");
              else if (type==="ul") insertAtCursor("- ");
              else if (type==="ol") insertAtCursor("1. ");
              else if (type==="link") { if (sel) wrap("[","](url)"); else insertAtCursor("[text](url)"); }
              else if (type==="textColor") wrap('<span style="color:'+(value||"#f0a63d")+'">',"</span>");
              else if (type==="clearFormatting") {
                let s = sel.replace(/\*\*/g,"").replace(/^\*|\*$/g,"").replace(/~~/g,"").replace(/<\/?[^>]+>/g,"").replace(/`/g,"").replace(/\$/g,"").replace(/==/g,"").replace(/[\^~]/g,"").replace(/style="[^"]*"/g,"");
                const nc = fullText.substring(0,start)+s+fullText.substring(end);
                updContent(activeTab, nc);
                restore(() => ta.setSelectionRange(start, start + s.length));
              }
            }}onUndo={() => document.execCommand("undo")}
            onRedo={() => document.execCommand("redo")}
            onAttach={() => {
              const ta = document.querySelector(".ms-edit-textarea") as HTMLTextAreaElement;
              const start = ta?.selectionStart??0, end = ta?.selectionEnd??0;
              const sel = edContent.substring(start, end);
              const wrapped = "![" + (sel||"image") + "](path/to/file)";
              const nc = edContent.substring(0, start) + wrapped + edContent.substring(end);
              updContent(activeTab, nc);
            }}
          />}
          {activeTab && (()=>{
            const af=openFiles.find(f=>f.path===activeTab);if(!af)return null;
            // Smooth scroll sync via requestAnimationFrame
            const syncScroll = (source) => {
              if (window._msSyncRaf) cancelAnimationFrame(window._msSyncRaf);
              window._msSyncRaf = requestAnimationFrame(() => {
                window._msSyncRaf = null;
                const ta = document.querySelector(".ms-edit-textarea");
                const pv = document.querySelector(".ms-preview-pane");
                if (!ta || !pv) return;
                if (source==="edit") {
                  const sh = ta.scrollHeight - ta.clientHeight;
                  if (sh > 0) { const r = ta.scrollTop / sh; pv.scrollTop = r * (pv.scrollHeight - pv.clientHeight); }
                } else {
                  const sh = pv.scrollHeight - pv.clientHeight;
                  if (sh > 0) { const r = pv.scrollTop / sh; ta.scrollTop = r * (ta.scrollHeight - ta.clientHeight); }
                }
              });
            };
            const editPane = <textarea key="edit" className="ms-edit-textarea"
              value={edContent} onChange={e=>updContent(activeTab,e.target.value)}
              onScroll={()=>syncScroll("edit")}
              placeholder="Start writing... Use [[wiki-links]] and #tags" style={{
                ...txStyle, borderRight:previewMode==="split"?"1px solid var(--glass-border)":"none"
              }} />;
            const previewPane = <div key="preview" className="ms-preview-pane"
              onScroll={()=>syncScroll("preview")} style={{
                flex:1, minHeight:0, overflow:"auto", padding:"20px 24px",
                background:"transparent"
              }}>
              <MarkdownRenderer content={edContent}
                onWikiLink={(title: string)=>{
                  const findNote = (nodes, ttl) => { for (const n of nodes) { if (n.type==="note" && (n.name.replace(/\.md$/,"").toLowerCase()===ttl.toLowerCase() || n.name===ttl+".md")) return n; if (n.children) { const r = findNote(n.children, ttl); if (r) return r; } } return null; };
                  const t = findNote(tree, title);
                  const fn = t ? t.path : title.replace(/[/\\?%*:|"<>]/g,"_")+".md";
                  openFile(fn);
                }}
                onTagClick={(tag: string)=>{setLeftTab("search");setSq(tag);}}
                onToggleCheckbox={(lineIndex: number)=>{
                  const lines = edContent.split("\n");
                  if (lineIndex >= lines.length) return;
                  const l = lines[lineIndex];
                  const m = l.match(/^(\s*(?:[-*+]\s+)?\[)([ xX])(\]\s*.*)/);
                  if (!m) return;
                  const newChar = m[2] === "x" || m[2] === "X" ? " " : "x";
                  lines[lineIndex] = m[1] + newChar + m[3];
                  updContent(activeTab, lines.join("\n"));
                }}
              />
            </div>;
            if (previewMode==="preview") return previewPane;
            if (previewMode==="split") return <div style={{flex:1,display:"flex",minHeight:0,flexDirection:"row"}}>{editPane}{previewPane}</div>;
            return editPane;
          })()}
          {!activeTab && <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,color:"var(--text-tertiary)"}}>
            <FileText size={40} strokeWidth={1}/>
            <span style={{fontSize:13}}>Select a note or create a new one</span>
          </div>}
        </div>
        </div>
      </div>
      {/* RIGHT SIDEBAR */}
      {rightOpen && <div style={{width:rightW,minWidth:200,display:"flex",flexDirection:"column",
        background:"var(--surface-glass)",border:"1px solid var(--glass-border)",borderRadius:12,
        margin:"4px 4px 4px 0",backdropFilter:"blur(8px)",position:"relative",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderBottom:"1px solid var(--glass-border)"}}>
          <div style={{display:"flex",gap:2}}>
            {([["backlinks",Link2],["outline",Type],["graph",Globe]] as const).map(([id,Icon])=>(
              <button key={id} onClick={()=>setRightTab(id as any)}
                style={{background:rightTab===id?"var(--track)":"transparent",border:"none",
                  padding:"4px 7px",borderRadius:6,cursor:"pointer",
                  color:rightTab===id?"var(--text-primary)":"var(--text-tertiary)"}}>
                <Icon size={13}/>
              </button>
            ))}
          </div>
          <button onClick={()=>setRightOpen(false)}
            style={{background:"transparent",border:"none",padding:3,cursor:"pointer",color:"var(--text-tertiary)"}}>
            <PanelRightClose size={13}/>
          </button>
        </div>
        <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"}}>
          {rightTab==="backlinks" && <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,position:"relative"}}>
            {/* Top: Backlinks panel (resizable) */}
            <div style={{flex:rightSplit,overflow:"auto",padding:"4px 6px",minHeight:100}}>
              {(()=>{
                const af = openFiles.find(f=>f.path===activeTab);
                if (!af) return <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>Open a note to see backlinks</div>;
                const bl = af.backlinks;
                const linked = bl.filter(b=>b.type==="linked");
                const unlinked = bl.filter(b=>b.type==="unlinked");
                return <>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.03em",padding:"4px 8px",marginBottom:2}}>Linked ({linked.length})</div>
                  {linked.map(b=>(
                    <div key={b.path} onClick={()=>openFile(b.path)}
                      style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,borderBottom:"1px solid var(--glass-border)"}}>
                      <span style={{fontWeight:600,color:"var(--amber)"}}>{b.name}</span>
                      <span style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.3}}>{b.snippet}</span>
                    </div>
                  ))}
                  <div style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.03em",padding:"4px 8px",marginTop:8,marginBottom:2}}>Unlinked ({unlinked.length})</div>
                  {unlinked.map(b=>(
                    <div key={b.path} onClick={()=>openFile(b.path)}
                      style={{display:"flex",flexDirection:"column",gap:2,padding:"5px 8px",borderRadius:6,cursor:"pointer",fontSize:12,borderBottom:"1px solid var(--glass-border)"}}>
                      <span style={{fontWeight:600,color:"var(--text-secondary)"}}>{b.name}</span>
                      <span style={{fontSize:11,color:"var(--text-tertiary)",lineHeight:1.3}}>{b.snippet}</span>
                    </div>
                  ))}
                  {bl.length===0 && <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>No backlinks</div>}
              </>;
            })()}
            </div>
            {/* Horizontal resize handle */}
            <div style={{height:4,cursor:"row-resize",background:"transparent",flexShrink:0,position:"relative",zIndex:5}}
              onMouseDown={(e)=>{
                e.preventDefault();
                const el = e.currentTarget.parentElement;
                if (!el) return;
                const startY = e.clientY;
                const startPct = rightSplit;
                const totalH = el.clientHeight;
                const onMove = (ev: MouseEvent) => {
                  const dy = ev.clientY - startY;
                  let pct = startPct + (dy / totalH * 100);
                  pct = Math.max(25, Math.min(80, pct));
                  setRightSplit(pct);
                };
                const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
              }}
            />
            {/* Bottom: Mini graph */}
            <div style={{flex:100-rightSplit,display:"flex",flexDirection:"column",minHeight:80,overflow:"hidden",borderTop:"1px solid var(--glass-border)"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 6px",borderBottom:"1px solid var(--glass-border)",flexShrink:0}}>
                <span style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.03em"}}>Local Graph</span>
                <button onClick={()=>setGraphFullscreen(true)}
                  style={{background:"transparent",border:"none",padding:3,cursor:"pointer",color:"var(--text-tertiary)",display:"flex"}} title="Expand graph">
                  <Maximize2 size={12}/>
                </button>
                <button onClick={()=>{setGraphDepth(5);setGraphShowOrphans(true);setGraphSearch("");}}
                  style={{background:"transparent",border:"1px solid var(--glass-border)",padding:"1px 5px",cursor:"pointer",color:"var(--teal)",display:"flex",borderRadius:4,fontSize:10,alignItems:"center",gap:2}} title="Show all">
                  <Globe size={10}/> All
                </button>
              </div>
              <div style={{flex:1,minHeight:0,overflow:"hidden",position:"relative"}}>
                <GraphView data={graphData} onNodeClick={(node)=>{openFile(node.id);}} />
              </div>
            </div>
          </div>}
          {rightTab==="outline" && <div style={{flex:1,overflow:"auto",padding:"4px 6px"}}>
            {(()=>{
              const af = openFiles.find(f=>f.path===activeTab);
              if (!af) return <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>Open a note to see outline</div>;
              return <>
                {af.outline.map((h,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:4,padding:"3px 6px",paddingLeft:6+(h.level-1)*14,cursor:"pointer",borderRadius:4,fontSize:12}}>
                    <span style={{fontSize:10,color:"var(--text-tertiary)",fontFamily:"var(--font-mono)",minWidth:14}}>H{h.level}</span>
                    <span style={{color:"var(--text-secondary)"}}>{h.text}</span>
                  </div>
                ))}
                {af.outline.length===0 && <div style={{padding:16,textAlign:"center",fontSize:12,color:"var(--text-tertiary)"}}>No headings</div>}
              </>;
            })()}
          </div>}
          {rightTab==="graph" && <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 6px",borderBottom:"1px solid var(--glass-border)",flexShrink:0,flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:600,color:"var(--text-secondary)",textTransform:"uppercase",letterSpacing:"0.03em"}}>Global Graph</span>
              <button onClick={()=>{setGraphDepth(5);setGraphShowOrphans(true);setGraphSearch("");}}
                style={{background:"transparent",border:"1px solid var(--glass-border)",padding:"1px 6px",cursor:"pointer",color:"var(--teal)",display:"flex",borderRadius:4,fontSize:10,alignItems:"center",gap:2,marginLeft:"auto"}} title="Show all">
                <Globe size={10}/> All
              </button>
              <button onClick={()=>setGraphFullscreen(true)}
                style={{background:"transparent",border:"none",padding:3,cursor:"pointer",color:"var(--text-tertiary)",display:"flex"}} title="Fullscreen">
                <Maximize2 size={12}/>
              </button>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 6px",borderBottom:"1px solid var(--glass-border)",flexShrink:0,flexWrap:"wrap"}}>
              <Search size={11} style={{color:"var(--text-tertiary)",flexShrink:0}}/>
              <input placeholder="Filter nodes..." value={graphSearch} onChange={e=>setGraphSearch(e.target.value)}
                style={{flex:1,minWidth:40,padding:"2px 4px",border:"none",background:"transparent",outline:"none",color:"var(--text-primary)",fontSize:11}}/>
              <label style={{fontSize:10,color:"var(--text-tertiary)",display:"flex",alignItems:"center",gap:2,flexShrink:0}}>
                <input type="checkbox" checked={graphShowOrphans} onChange={e=>setGraphShowOrphans(e.target.checked)}/> Orphans
              </label>
              <label style={{fontSize:10,color:"var(--text-tertiary)",display:"flex",alignItems:"center",gap:2,flexShrink:0}}>
                Depth
                <select value={graphDepth} onChange={e=>setGraphDepth(Number(e.target.value))}
                  style={{padding:"1px 2px",border:"1px solid var(--glass-border)",background:"var(--track)",color:"var(--text-primary)",fontSize:10,borderRadius:4}}>
                  {[1,2,3,4,5].map(d=><option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            </div>
            <div style={{flex:1,minHeight:0,overflow:"hidden",position:"relative"}}>
              <GraphView data={graphData} onNodeClick={(node)=>{openFile(node.id);}} />
            </div>
          </div>}
          </div>
          <div onMouseDown={(e)=>startRes("r",e)} style={{position:"absolute",left:0,top:0,bottom:0,width:4,cursor:"col-resize"}} />
        </div>}
      </div>)}
    {/* ─── TASKS VIEW ─── */}
    {myspaceView === "tasks" && (
      <div style={{display:"flex",flex:1,minHeight:0,overflow:"hidden", margin:"4px"}}>
        <TasksPanel
          onOpenNote={openFile}
          vaultFiles={tree?.map(f => f.name.replace(/\.md$/i, '')) || []}
        />
      </div>
    )}
    {/* Fullscreen Graph Modal */}
      {graphFullscreen && <div onClick={()=>setGraphFullscreen(false)}
        style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center"}}
        onKeyDown={(e)=>{if(e.key==="Escape")setGraphFullscreen(false);}} tabIndex={0}
      >
        <div onClick={(e)=>e.stopPropagation()}
          style={{width:"92vw",height:"78vh",background:"var(--surface-glass)",border:"1px solid var(--glass-border)",borderRadius:16,display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",borderBottom:"1px solid var(--glass-border)",flexShrink:0}}>
            <span style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:15,fontWeight:600,color:"var(--text-primary)"}}>Graph View</span>
              <button onClick={()=>{setGraphDepth(5);setGraphShowOrphans(true);setGraphSearch("");}}
                style={{background:"transparent",border:"1px solid var(--glass-border)",padding:"3px 10px",cursor:"pointer",color:"var(--teal)",display:"flex",borderRadius:6,fontSize:12,alignItems:"center",gap:4}} title="Show all nodes and connections">
                <Globe size={13}/> Show all
              </button>
            </span>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:12,color:"var(--text-tertiary)",display:"flex",alignItems:"center",gap:8}}>
                <label style={{display:"flex",alignItems:"center",gap:3}}>
                  <input type="checkbox" checked={graphShowOrphans} onChange={e=>setGraphShowOrphans(e.target.checked)}/> Orphans
                </label>
                <label style={{display:"flex",alignItems:"center",gap:3}}>Depth
                  <select value={graphDepth} onChange={e=>setGraphDepth(Number(e.target.value))}
                    style={{padding:"2px 6px",border:"1px solid var(--glass-border)",background:"var(--track)",color:"var(--text-primary)",fontSize:11,borderRadius:4}}>
                    {[1,2,3,4,5].map(d=><option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              </span>
              <button onClick={()=>setGraphFullscreen(false)}
                style={{background:"transparent",border:"none",padding:"4px 10px",cursor:"pointer",color:"var(--text-tertiary)",display:"flex",borderRadius:6}} title="Close (Esc)">
                <X size={18}/>
              </button>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 16px",borderBottom:"1px solid var(--glass-border)",flexShrink:0}}>
            <Search size={14} style={{color:"var(--text-tertiary)",flexShrink:0}}/>
            <input placeholder="Search nodes..." value={graphSearch} onChange={e=>setGraphSearch(e.target.value)}
              style={{flex:1,padding:"4px 8px",border:"none",background:"transparent",outline:"none",color:"var(--text-primary)",fontSize:13}}/>
          </div>
          <div style={{flex:1,minHeight:0,position:"relative"}}>
            <GraphView data={graphData} onNodeClick={(node)=>{openFile(node.id);}} />
          </div>
        </div>
      </div>}
    </div>);
}









