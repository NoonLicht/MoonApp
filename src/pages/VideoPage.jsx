import React,{useState,useEffect}from"react"
import{Video,Download,Link2,AlertTriangle,RefreshCw,Check,Image,Subtitles,Terminal}from"lucide-react"
import{Glass,Btn,Badge,Select,SectionHead,EmptyHint,ProgressBar}from"../components/ui"
import{usePageToolbar}from"../components/Toolbar"
import{useI18n}from"../i18n"
import{api}from"../api/client"
const C=["MP4","WEBM","MKV"]
const fmt=n=>n?(n/1024/1024).toFixed(1)+" MB":""
export default function VPage(){const{t}=useI18n()
const[u,su]=useState("");const[st,sSt]=useState("idle");const[i,sI]=useState(null)
const[h,sH]=useState(null);const[c,sC]=useState("MP4");const[j,sJ]=useState(null)
const[p,sP]=useState(0);const[jf,sJF]=useState([]);const[err,sE]=useState("")
const[sub,sSub]=useState([]);const[et,sET]=useState(false);const[ins,sIns]=useState(null)
useEffect(()=>{if(j){const t=setInterval(async()=>{try{const st=await api.getVideoJobStatus(j);sP(st.progress||0);if(st.state==="done"){sSt("done");sJF(st.files||[]);clearInterval(t)}if(st.state==="error"){sSt("error");sE(st.error||"");clearInterval(t)}}catch{}},800);return()=>clearInterval(t)}},[j])
useEffect(()=>{if(ins?.state!=="working")return;const t=setInterval(async()=>{try{const st=await api.getVideoInstall();sIns(st)}catch{}},900);return()=>clearInterval(t)},[ins?.state])
usePageToolbar(<Select value={c} onChange={e=>sC(e.target.value)} options={C}/>,[c])
const fi=async()=>{if(!u.trim())return;sSt("parsing");sE("");try{const d=await api.getVideoInfo(u.trim());sI(d);sH(d.heights[0]||null);sSub([]);sSt("ready")}catch(e){sSt("error");sE(e.message)}}
const dl=async()=>{if(!i)return;sSt("downloading");sP(0);sE("");try{const r=await api.startVideoDownload({url:i.webUrl||u,info:i,height:h||undefined,container:c,subs:sub.length?sub:undefined,thumb:et?{embed:true}:undefined});sJ(r.id)}catch(e){sSt("error");sE(e.message)}}
const dlFile=async(k)=>{try{const {blob,name}=await api.downloadVideoFile(k);const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),4000)}catch(e){sSt("error");sE(e.message)}}
const si=async()=>{try{const st=await api.startVideoInstall();sIns(st)}catch(e){sE(e.message)}}
return(<div className="page"><SectionHead eyebrow={t("video.eyebrow")} title={t("video.title")}/>
{ins&&!ins.installed&&(<Glass className="source-placeholder"style={{borderColor:"var(--coral)",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}><AlertTriangle size={16}style={{color:"var(--coral)"}}/><span className="muted-sm">{t("video.ytdlpMissing")}</span>{ins.state==="working"?(<div className="install-progress"style={{width:"100%"}}><div className="muted-sm"><RefreshCw size={14}className="spin"/> {ins.phase==="extract"?t("conv.installing"):t("conv.downloading",{p:ins.progress})}</div><ProgressBar value={ins.progress}/></div>):(<Btn variant="primary"icon={Terminal} onClick={si}style={{width:180}}>{t("conv.install")}</Btn>)}</Glass>)}
<Glass className="url-bar"><Link2 size={16}/><input placeholder={t("video.paste")}value={u}onChange={e=>su(e.target.value)}onKeyDown={e=>e.key==="Enter"&&fi()}/><Btn variant="primary"onClick={fi}disabled={st==="parsing"}>{st==="parsing"?t("video.fetching"):t("video.fetch")}</Btn></Glass>
{st==="idle"&&<EmptyHint icon={Video}text={t("video.empty")}/>}
{st==="parsing"&&<Glass><span className="muted-sm">{t("video.fetching")}</span></Glass>}
{st==="ready"&&i&&(<Glass className="media-preview"><div className="media-thumb tone-amber">{i.thumbnail?<img src={i.thumbnail}alt=""style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:10}}/>:<Video size={26}/>}</div><div className="media-info"><div className="media-title">{i.title}</div><div className="muted-sm">{i.durationString||""}·{i.heights.length}res{i.subtitles&&Object.keys(i.subtitles).length?"·subs":""}</div><div className="quality-row">{i.heights.slice(0, 15).map((_h, idx)=><Badge key={idx}tone="amber"mono active={_h===h}onClick={()=>sH(_h)}>{_h>=2160?"4K":_h+"p"}</Badge>)}</div><div className="quality-row"style={{gap:4}}><Badge tone="neutral"mono>{c}</Badge>{Object.keys(i.subtitles||{}).length>0&&(<Badge tone="teal"mono active={sub.length}onClick={()=>sSub(sub.length?[]:Object.keys(i.subtitles))}><Subtitles size={12}/>Sub</Badge>)}<Badge tone={et?"violet":"neutral"}mono onClick={()=>sET(!et)}><Image size={12}/>{et?"thumb in":"thumb"}</Badge></div><Btn variant="primary"icon={Download}onClick={dl}style={{width:260}}>{t("video.download",{quality:h?h+"p":"best"})}</Btn></div></Glass>)}
{st==="downloading"&&(<Glass><div style={{width:"100%",display:"flex",flexDirection:"column",gap:8}}><div className="muted-sm"><RefreshCw size={14}className="spin"/> {t("video.downloading",{p})}</div><ProgressBar value={p}/></div></Glass>)}
{st==="done"&&jf.length>0&&(<Glass className="media-preview"><div style={{width:"100%",display:"flex",flexDirection:"column",gap:8}}><div style={{color:"var(--success)"}}><Check size={16}/>{t("video.saved")}</div>{jf.map(f=>(<div key={f.key}style={{display:"flex",alignItems:"center",gap:8}}><span className="muted-sm">{f.name}·{fmt(f.size)}</span><Btn variant="primary"icon={Download}onClick={()=>dlFile(f.key)}>{t("video.download")}</Btn></div>))}</div></Glass>)}
{st==="error"&&err&&(<Glass className="source-placeholder"style={{borderColor:"var(--coral)"}}><AlertTriangle size={16}style={{color:"var(--coral)"}}/><span>{err}</span></Glass>)}
</div>)}
