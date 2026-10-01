import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * First-party tracker (~1.5 KB). Sets a random visitor id in a first-party
 * cookie on the product's own domain, sends PAGE_VIEW (with referrer and
 * UTM/ref parameters) and CTA_CLICK for elements with `data-beacon-cta`.
 * Honours Do-Not-Track / Global Privacy Control. No fingerprinting.
 */
export function GET() {
  const endpoint = `${env().BEACON_BASE_URL}/api/v1/events`;
  const js = `(function(){
  var s=document.currentScript; if(!s) return;
  var key=s.getAttribute("data-key"), product=s.getAttribute("data-product");
  if(!key||navigator.doNotTrack==="1"||navigator.globalPrivacyControl) return;
  var m=document.cookie.match(/(?:^|; )bcn_vid=([A-Za-z0-9_-]{8,64})/), vid=m&&m[1];
  if(!vid){var a=new Uint8Array(12);crypto.getRandomValues(a);vid=Array.from(a,function(b){return ("0"+b.toString(16)).slice(-2)}).join("");
    document.cookie="bcn_vid="+vid+"; Max-Age=31536000; Path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");}
  function send(ev){ev.key=key;ev.product=product;ev.visitorId=vid;ev.url=location.href;
    var body=JSON.stringify(ev); if(navigator.sendBeacon&&navigator.sendBeacon(${JSON.stringify(endpoint)},new Blob([body],{type:"text/plain"}))) return;
    fetch(${JSON.stringify(endpoint)},{method:"POST",body:body,keepalive:true,mode:"cors",headers:{"content-type":"text/plain"}}).catch(function(){});}
  send({type:"PAGE_VIEW",referrer:document.referrer||null});
  document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("[data-beacon-cta]"); if(el) send({type:"CTA_CLICK",ctaId:String(el.getAttribute("data-beacon-cta")).slice(0,100)});},true);
  window.beacon={visitorId:vid,track:function(t,p){send({type:t,properties:p||{}})}};
})();`;
  return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
