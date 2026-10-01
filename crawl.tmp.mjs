import { chromium } from "@playwright/test";
import fs from "node:fs";
const SP = process.argv[2];
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function login(locale) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "beacon_locale", value: locale, url: "http://localhost:3100" }]);
  const p = await ctx.newPage();
  await p.goto("http://localhost:3100/login");
  await p.fill('input[name="email"]', "owner@beacon.test");
  await p.fill('input[name="password"]', "correct-horse-battery-9");
  await p.locator('button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));
  return p;
}
const en = await login("en"), fr = await login("fr");
const seen = new Set(), queue = ["/"], report = {};
const text = async (p) => (await p.evaluate(() => {
  const out = [];
  const w = document.createTreeWalker(document.querySelector("main") ?? document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const el = w.currentNode.parentElement; if (!el || el.closest("script,style,code,pre,textarea")) continue; const s = w.currentNode.textContent.trim(); if (s) out.push(s); }
  document.querySelectorAll("main [placeholder],main [title],main [aria-label]").forEach((e) => ["placeholder","title","aria-label"].forEach((a) => e.getAttribute(a) && out.push(`@${a}:` + e.getAttribute(a))));
  return out;
}));
while (queue.length && seen.size < 60) {
  const path = queue.shift(); if (seen.has(path)) continue; seen.add(path);
  await en.goto("http://localhost:3100" + path); await fr.goto("http://localhost:3100" + path);
  const links = await en.evaluate(() => [...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href")));
  for (const l of links) { const u = l.split("#")[0]; const key = u.replace(/\?.*$/, ""); if (!key.startsWith("/p/") && !key.startsWith("/api") && !key.startsWith("/r/") && ![...seen].some((s) => s.replace(/\?.*$/,"") === key) && !queue.some((q) => q.replace(/\?.*$/,"") === key)) queue.push(u); }
  const a = await text(en), f = new Set(await text(fr));
  report[path] = [...new Set(a.filter((s) => f.has(s) && /[a-z]{3,}/i.test(s)))];
}
fs.writeFileSync(`${SP}/same.json`, JSON.stringify(report, null, 1));
await fr.goto("http://localhost:3100/"); await fr.setViewportSize({ width: 390, height: 844 }); await fr.screenshot({ path: `${SP}/fr-mobile.png` });
await b.close();
console.log(Object.keys(report).length, "pages");
