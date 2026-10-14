
window.APP_CONFIG={supabaseUrl:"preview",supabaseKey:"preview",staffQrApi:"/none"};
(function(){
  const ACC={"mgr@t":{role:"manager",displayName:"青山店 店長"},"staff@t":{role:"staff",displayName:"青山店"},"viewer@t":{role:"viewer",displayName:"本部(閲覧)"}};
  let me=null; const now=Date.now(), day=86400000, iso=(t)=>new Date(t).toISOString();
  const NAMES=["佐藤 花子","鈴木 一郎","高橋 美咲","田中 健太","伊藤 由美","渡辺 翔","山本 さくら","中村 大輔","小林 彩","加藤 拓也","吉田 結衣","山田 蓮","佐々木 葵","山口 陽菜","松本 悠真","井上 美月","木村 颯","林 七海","清水 大和","山崎 心春","森 湊","池田 莉子","橋本 樹","阿部 紬"];
  const RANKS=["white_opal","white_opal","white_opal","amber","amber","emerald","ruby","onyx"];
  const members=NAMES.map((nm,i)=>{const id="m"+(i+1), no="AO"+String(1001+i).padStart(5,"0"); const L=[]; let bal=0; const add=(type,rule,pts,t,reason)=>{bal+=pts;L.push({id:id+"-"+L.length,type,rule,points:pts,balanceAfter:bal,reason:reason||null,source:"preview",at:iso(t)});};
    const created=now-(40-i)*day; add("earn","welcome",100,created); for(let k=0;k<(i%7)+1;k++) add("earn","visit",100,created+(k+1)*3*day); if(i%3===0) add("redeem",null,-100,now-2*day); if(i===4) add("adjust",null,50,now-day,"紙の台帳との差異の訂正");
    L.reverse(); return {id,memberNo:no,displayName:nm,rank:RANKS[i%RANKS.length],points:bal,status:"active",lastActivityOn:new Date(now-(i%5)*day).toISOString().slice(0,10),createdAt:iso(created),lifetimePoints:L.filter(l=>l.type==="earn").reduce((a,l)=>a+l.points,0)+(i%4===0?2000:0),lifetimeConfirmed:i%4!==1,ledger:L};});
  const slot=Math.floor(now/30000)-40;
  const visits=members.slice(0,9).map((m,i)=>({memberNo:m.memberNo,displayName:m.displayName,at:iso(now-(i<6?40*30000:i*3600000)),slot:i<6?slot:slot-i*100}));
  let redeems={"123456":{id:"r1",points:300,yen:30,member:members[6],status:"pending"},"222222":{id:"r2",points:100,yen:10,member:members[1],status:"expired"}};
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const R={
    staff_whoami:()=>me?{active:true,...ACC[me]}:{active:false},
    staff_dashboard:()=>({asOf:iso(Date.now()),state:"test",reconciled:true,membersActive:members.length,visitsToday:visits.length,pointsIssuedThisMonth:4200,pointsRedeemedThisMonth:800,pendingRedeems:1,lastBackupAt:iso(now-40*3600000),backupStale:true,undecidedPolicies:[],balanceMismatches:0}),
    staff_list_members:(a)=>{const q=(a.p_query||"").trim(); const hit=members.filter(m=>!q||m.memberNo.includes(q)||m.displayName.includes(q)); const lim=Math.min(a.p_limit||50,100), off=a.p_offset||0; return {total:hit.length,items:hit.slice(off,off+lim).map(({ledger,createdAt,lifetimePoints,lifetimeConfirmed,...x})=>x)};},
    staff_member_detail:(a)=>{const m=members.find(x=>x.id===a.p_member_id); if(!m) return {status:"not_found"}; const {ledger,...mm}=m; return {status:"ok",member:mm,ledger};},
    staff_today_visits:()=>({date:new Date().toISOString().slice(0,10),items:visits,suspiciousSlots:[{slot,count:6}]}),
    staff_lookup_redeem:(a)=>{ if(ACC[me].role==="viewer") throw {message:"forbidden"}; const r=redeems[a.p_code]; if(!r||r.status==="done") return {status:"not_found"}; const m=r.member; return {status:"ok",request:{id:r.id,points:r.points,yen:r.yen},member:{displayName:m.displayName,memberNo:m.memberNo,points:m.points}};},
    staff_confirm_redeem:(a)=>{const r=Object.values(redeems).find(x=>x.id===a.p_request_id); if(r.status==="expired") return {status:"expired"}; r.status="done"; r.member.points-=r.points; return {status:"confirmed",points:r.points,yen:r.yen,balanceAfter:r.member.points};},
    staff_cancel_redeem:()=>({status:"ok"}),
    manager_adjust:(a)=>{ if(ACC[me].role!=="manager") throw {message:"forbidden"}; if(!a.p_reason||!String(a.p_reason).trim()||!Number.isInteger(a.p_points)||a.p_points===0) throw {message:"reason_required"}; const m=members.find(x=>x.id===a.p_member_id); if(m.points+a.p_points<0) return {status:"insufficient_balance"}; m.points+=a.p_points; m.ledger.unshift({id:"adj"+Date.now(),type:"adjust",rule:null,points:a.p_points,balanceAfter:m.points,reason:a.p_reason,at:iso(Date.now())}); return {status:"ok"};},
  };
  window.supabase={createClient:()=>({
    auth:{signInWithPassword:async({email,password})=>{await wait(150); if(ACC[email]&&password==="pw"){me=email;return {data:{},error:null};} return {data:null,error:{message:"invalid"}};},
          signOut:async()=>{me=null;return {error:null};}, getSession:async()=>({data:{session:null}})},
    rpc:async(name,args)=>{await wait(name==="staff_member_detail"?30:200); try{ return {data:R[name](args||{}),error:null}; }catch(e){ return {data:null,error:e}; }},
  })};
})();
