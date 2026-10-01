/**
 * First-party tracker (about 2 KB). Sets a random visitor id in a first-party
 * cookie on the product's own domain and a session in sessionStorage (new
 * session after 30 minutes of inactivity or when the landing URL carries new
 * UTM parameters). Sends PAGE_VIEW on load and on SPA navigation
 * (history.pushState / replaceState / popstate), CTA_CLICK for elements with
 * `data-beacon-cta`, and the session's landing page and UTM with every event.
 * Honours Do-Not-Track / Global Privacy Control (sends nothing). No
 * fingerprinting; identity and consent are never sent from the browser.
 * Kept outside the route file so it can be unit tested.
 */
export function trackerSource(endpoint: string) {
  return `(function(){
var s=document.currentScript;if(!s)return;
var key=s.getAttribute("data-key"),product=s.getAttribute("data-product"),E=${JSON.stringify(endpoint)};
if(!key||navigator.doNotTrack==="1"||navigator.globalPrivacyControl)return;
function rid(){var a=new Uint8Array(12);crypto.getRandomValues(a);return Array.from(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
var m=document.cookie.match(/(?:^|; )bcn_vid=([A-Za-z0-9_-]{8,64})/),vid=m&&m[1];
if(!vid){vid=rid();document.cookie="bcn_vid="+vid+"; Max-Age=31536000; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"")}
function utm(){var q=new URLSearchParams(location.search),u={},n=0;["source","medium","campaign","term","content"].forEach(function(k){var v=q.get("utm_"+k);if(v){u[k]=v.slice(0,200);n++}});return n?u:null}
var S;function sess(){var x=S,now=Date.now(),u=utm();try{x=JSON.parse(sessionStorage.getItem("bcn_s")||"null")||x}catch(e){}
if(!x||now-x.t>18e5||(u&&JSON.stringify(u)!==JSON.stringify(x.u)))x={id:rid(),l:location.href,u:u||{}};
x.t=now;S=x;try{sessionStorage.setItem("bcn_s",JSON.stringify(x))}catch(e){}return x}
function send(ev){var x=sess();ev.key=key;ev.product=product;ev.visitorId=vid;ev.sessionId=x.id;ev.url=location.href;ev.landingUrl=x.l;for(var k in x.u){ev.utm=x.u;break}
var b=JSON.stringify(ev);if(navigator.sendBeacon&&navigator.sendBeacon(E,new Blob([b],{type:"text/plain"})))return;
fetch(E,{method:"POST",body:b,keepalive:true,mode:"cors",headers:{"content-type":"text/plain"}}).catch(function(){})}
var last=location.href;send({type:"PAGE_VIEW",referrer:document.referrer||null});
function nav(){var h=location.href;if(h.split("#")[0]===last.split("#")[0])return;var r=last;last=h;send({type:"PAGE_VIEW",referrer:r})}
["pushState","replaceState"].forEach(function(f){var o=history[f];history[f]=function(){var r=o.apply(this,arguments);nav();return r}});
addEventListener("popstate",nav);
document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("[data-beacon-cta]");if(el)send({type:"CTA_CLICK",ctaId:String(el.getAttribute("data-beacon-cta")).slice(0,100)})},true);
window.beacon={visitorId:vid,session:function(){return sess().id},track:function(t,p){send({type:t,properties:p||{}})}};
})();`;
}
