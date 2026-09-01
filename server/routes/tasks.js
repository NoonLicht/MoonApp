const express = require("express");
const path = require("path");
const fs2 = require("fs");
const { stmts, tables } = require("../db");
const logger = require("../logger");

const router = express.Router();

// TASKS
router.get("/",(req,res)=>res.json(stmts.taskAll.all()));

router.post("/",(req,res)=>{
  const{text,priority="Med",tag="General",due_date,recurring,tags}=req.body||{};
  if(!text||!String(text).trim())return res.status(400).json({error:"empty task"});
  const info=stmts.taskInsert.run(String(text).trim(),0,priority,tag);
  const task=stmts.taskAll.all().find(t=>t.id===info.lastInsertRowid);
  if(due_date)stmts.taskUpdate.run(due_date,"due_date",task.id);
  if(recurring)stmts.taskUpdate.run(recurring,"recurring",task.id);
  if(tags)stmts.taskUpdate.run(JSON.stringify(tags),"tags",task.id);
  const upd=stmts.taskAll.all().find(t=>t.id===info.lastInsertRowid);
  logger.action("task.add",{id:upd.id});
  res.status(201).json(upd);
});

router.patch("/:id",(req,res)=>{
  const id=Number(req.params.id);
  const{done,priority,tag,text,due_date,recurring,tags}=req.body||{};
  const ex=stmts.taskAll.all().find(t=>t.id===id);
  if(!ex)return res.status(404).json({error:"not found"});
  if(done!=null)stmts.taskToggle.run(done?1:0,id);
  if(priority)stmts.taskUpdate.run(priority,"priority",id);
  if(tag)stmts.taskUpdate.run(tag,"tag",id);
  if(text)stmts.taskUpdate.run(String(text).trim(),"text",id);
  if(due_date)stmts.taskUpdate.run(due_date,"due_date",id);
  if(recurring)stmts.taskUpdate.run(recurring,"recurring",id);
  if(tags)stmts.taskUpdate.run(JSON.stringify(tags),"tags",id);
  logger.action("task.update",{id});
  res.json(stmts.taskAll.all().find(t=>t.id===id));
});

router.put("/order",(req,res)=>{
  (req.body||{}).ids?.forEach((id,i)=>stmts.taskOrder.run(i,Number(id)));
  res.json({ok:true});
});

router.delete("/:id",(req,res)=>{
  stmts.taskDelete.run(Number(req.params.id));
res.json({ok:true});
});

// NOTES
router.get("/notes",(req,res)=>{
  try{
    const notes=stmts.noteAll.all();
    const folders=[...new Set(notes.map(n=>n.folder||"").filter(Boolean))];
    res.json({notes,folders});
  }catch(e){res.status(500).json({error:e.message});}
});

router.get("/notes/search",(req,res)=>{
  try{
    const q=String(req.query.q||"").toLowerCase().trim();
    if(!q)return res.json([]);
    res.json(stmts.noteSearch.all(q));
  }catch(e){res.status(500).json({error:e.message});}
});

router.get("/notes/:id",(req,res)=>{
  try{
    const note=stmts.noteGet.get(Number(req.params.id));
    if(!note)return res.status(404).json({error:"not found"});
    const all=stmts.noteAll.all();
    const wl=[...note.content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m=>m[1]);
    const lt=wl.map(t=>{const f=all.find(n=>n.title.toLowerCase()===t.toLowerCase());return{title:t,exists:!!f,targetId:f?f.id:null};});
    const bl=all.filter(n=>n.id!==note.id&&new RegExp("\\[\\["+esc(note.title)+"\\]\\]","i").test(n.content)).map(n=>({id:n.id,title:n.title}));
    res.json({...note,wikiLinks:wl,backlinks:bl,linkTargets:lt});
  }catch(e){res.status(500).json({error:e.message});}
});

router.post("/notes",(req,res)=>{
  try{
    const{title,content="",tags="",folder=""}=req.body||{};
    if(!title||!String(title).trim())return res.status(400).json({error:"empty title"});
    const info=stmts.noteInsert.run(String(title).trim(),content,tags,folder);
    const note=stmts.noteAll.all().find(n=>n.id===info.lastInsertRowid);
    logger.action("note.add",{id:note.id,title:note.title});
    res.status(201).json(note);
  }catch(e){res.status(500).json({error:e.message});}
});

router.patch("/notes/:id",(req,res)=>{
  try{
    const id=Number(req.params.id);
    const ex=stmts.noteGet.get(id);
    if(!ex)return res.status(404).json({error:"not found"});
    const{title,content,tags,folder}=req.body||{};
    stmts.noteUpdate.run(title!=null?String(title).trim():ex.title,content!=null?content:ex.content,tags!=null?tags:ex.tags,folder!=null?folder:ex.folder,id);
    logger.action("note.update",{id});
    res.json(stmts.noteGet.get(id));
  }catch(e){res.status(500).json({error:e.message});}
});

router.delete("/notes/:id",(req,res)=>{
  try{stmts.noteDelete.run(Number(req.params.id));res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}
});

// GRAPH
router.get("/graph",(req,res)=>{
  try{
    const nid=Number(req.query.noteId)||0;
    const notes=stmts.noteAll.all();
    const tasks=stmts.taskAll.all();
    const nodes=[...notes.map(n=>({id:"n"+n.id,type:"note",label:n.title,noteId:n.id})),...tasks.map(t=>({id:"t"+t.id,type:"task",label:t.text,taskId:t.id,done:!!t.done}))];
    const map=new Map();for(const n of notes)map.set(n.title.toLowerCase(),n.id);
    const edges=[];
    for(const n of notes){const ls=[...n.content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m=>m[1].toLowerCase());for(const l of ls)if(map.has(l))edges.push({source:"n"+n.id,target:"n"+map.get(l)});}
    if(nid){const s=new Set(["n"+nid]);for(const e of edges){if(e.source==="n"+nid)s.add(e.target);if(e.target==="n"+nid)s.add(e.source);}return res.json({nodes:nodes.filter(n=>s.has(n.id)),edges:edges.filter(e=>s.has(e.source)&&s.has(e.target))});}
    res.json({nodes,edges});
  }catch(e){res.status(500).json({error:e.message});}
});

// IMPORT OBSIDIAN VAULT
router.post("/import-vault",(req,res)=>{
  try{
    const{dirPath}=req.body||{};
    if(!dirPath||!fs2.existsSync(dirPath))return res.status(400).json({error:"Directory not found"});
    const files=fs2.readdirSync(dirPath).filter(f=>f.endsWith(".md"));
    let imported=0,skipped=0;
    for(const file of files){
      const fp=path.join(dirPath,file);
      const content=fs2.readFileSync(fp,"utf8");
      let title=file.replace(/\.md$/,"");
      let tags="",body=content;
      if(body.startsWith("---")){const end=body.indexOf("---",3);if(end>0){const fm=body.slice(3,end).trim();body=body.slice(end+3).trim();for(const ln of fm.split("\n")){const m=ln.match(/^tags:\s*\[(.+)\]$/);if(m)tags=m[1];const m2=ln.match(/^title:\s*(.+)$/);if(m2)title=m2[1].trim().replace(/^["']|["']$/g,"");}}}
      const it=[...body.matchAll(/(?:^|\s)(#[a-zA-Zа-яА-Я0-9_\/-]+)/g)].map(m=>m[1]);
      const at=tags?tags.split(",").map(t=>t.trim()).concat(it).filter(Boolean).join(","):it.join(",");
      if(stmts.noteAll.all().find(n=>n.title.toLowerCase()===title.toLowerCase())){skipped++;continue;}
      const rp=path.relative(dirPath,fp);const folder=path.dirname(rp)==="."?"":path.dirname(rp).replace(/\\/g,"/");
      stmts.noteInsert.run(title,body,at,folder);imported++;
    }
    logger.action("vault.import",{imported,skipped});
    res.json({imported,skipped,total:files.length});
  }catch(e){res.status(500).json({error:e.message});}
});

// EXPORT
router.get("/notes/:id/export",(req,res)=>{
  try{
    const note=stmts.noteGet.get(Number(req.params.id));
    if(!note)return res.status(404).json({error:"not found"});
    const fm=["---",'title: "'+note.title+'"'];
    if(note.tags)fm.push("tags: ["+note.tags+"]");
    if(note.folder)fm.push("folder: "+note.folder);
    fm.push("created: "+note.created_at,"updated: "+note.updated_at,"---");
    const md=fm.join("\n")+"\n"+(note.content||"");
    res.setHeader("Content-Type","text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition",'attachment; filename="'+encodeURIComponent(note.title)+'.md"');
    res.send(md);
  }catch(e){res.status(500).json({error:e.message});}
});

function esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
module.exports = router;